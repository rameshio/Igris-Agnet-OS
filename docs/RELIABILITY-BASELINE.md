# RELIABILITY BASELINE — G0 (Stabilization Prep)

> **G0 is inspection + design only.** No retry engine, reassignment, backoff, stale-run
> recovery, or GC was implemented. This document maps the *current* failure/recovery
> behavior from direct code inspection and defines the exact integration points for a
> future **G1**. Produced 2026-08-24; verified against code at HEAD `c82225e`.
>
> Companion to `docs/FULL-SYSTEM-AUDIT.md` (finding **H1**) and `docs/PHASE-STATUS.md`.

## G1 — IMPLEMENTED (bounded task-retry foundation)

Landed on top of this baseline (see `docs/PHASE-STATUS.md` "G1" + `docs/CHANGE-LOG.md`):

- **IP-1 ✅ Preserve error codes.** `AgentRunResult.code` + `AgentRun.errorCode` (new `agent_runs.error_code` column); `runtime.run` captures the thrown `ModelRouteError`/`NodeExecError` code and **redacts** the summary. A failure is no longer an opaque string.
- **Classifier ✅.** `lib/company/manager/failure.ts` (pure) — `classifyFailure(code)` → conservative taxonomy over the EXISTING codes; `decideRetry` + `isAutomaticallyRetryable`. Reuses codes; no parallel error system.
- **IP-3 ✅ Attempt tracking + controlled transition.** Additive `company_tasks.attempt_count`/`max_attempts` (+ `last_failure_code`/`class`/`summary`/`at`). `attemptCount` bumps exactly once per real dispatch (`beginTaskAttempt`, at `running`), never on eligibility/preview/planning/gap/approval-wait. `failed` stays terminal in `TASK_TRANSITIONS`; the **only** `failed→queued` path is the dedicated retry service (direct write, mirroring the `archived` pattern) — an ordinary `updateCompanyTask` still rejects it.
- **IP-2 / IP-5 ✅ Retry decision + execution.** `lib/company/manager/retry.ts` — `recordTaskFailure`, `promoteRetryableFailures` (Manager auto-retry pass inside `managerStep`, transient classes only), and `retryTask` (explicit human retry). Retry stays a company/manager-level decision; low-level runtime never retries.
- **IP-7 ✅ Events.** additive `TASK_RETRY_QUEUED` / `TASK_RETRY_EXHAUSTED`.
- **Surfaces ✅.** `GET /api/company-tasks/:id` returns the additive `retry` decision; new `POST /api/company-tasks/:id/retry`; CLI `igris task retry` + attempts/last-failure in `task show`; MissionsBoard shows attempts, failure reason, and a Retry/exhausted control.

**NOT implemented in G1 (still deferred — see §10 non-goals):** IP-4 restart / stale-running recovery for agent tasks *(now delivered in G2, below)*; agent reassignment; backoff/`next_retry_at` (retry is checked on the next `managerStep`, no scheduler); IP-6 mission `blocked` remodel; provider/tool fallback (still none — invariant 15/32 intact). A missing-config failure that is later fixed is not auto-revived (it is non-retryable by class) — documented G2 follow-on.

---

## G2 — IMPLEMENTED (stale-running recovery for agent tasks) — closes IP-4

- **Stale-running rule (deterministic, no wall-clock):** a Company Task is stale iff `status==='running'` AND `executionKind !== 'workflow'` AND it is **not** in the in-memory active-agent-task set (`globalThis.__igrisActiveAgentTasks`, pinned like the flow coordinator's active-run set per INC-001/D11). Agent dispatch is synchronous + in-process, so a `running` agent task is legitimately active only while its id is in that set; after a process restart the set is empty ⇒ every running agent task is provably stale. A live in-flight dispatch is protected (its id is in the set for the whole `await runtime.run`). **No duration timeout is used.**
- **Active-vs-stale evidence:** the in-memory active set is the process-boundary signal. `dispatchAgent` adds the task id before the run and removes it in `finally`; recovery treats a running agent task NOT in the set as interrupted.
- **Recovery service** (`lib/company/manager/recovery.ts`, `recoverStaleRunningTasks`): for each stale agent task, transition `running → failed` (guarded), then stamp an interruption code **without touching `attemptCount`**, emit one `TASK_EXECUTION_INTERRUPTED` event, create **no** artifact, and dispatch nothing. Decision states: `ACTIVE` (untouched), `RECOVERED_INTERRUPTED` (safe), `RECOVERED_REVIEW_REQUIRED` (unsafe).
- **Interruption codes/classes** (added to the G1 classifier): `execution_interrupted` → `EXECUTION_INTERRUPTED` (retryable like a transient; auto-retry still additionally gated on `isTaskAutoRetrySafe`); `execution_interrupted_review` → `INTERRUPTED_REVIEW_REQUIRED` (human action, NEVER auto- or one-click-retried). The recovery service picks the code by side-effect safety (`isTaskAutoRetrySafe` — the agent's tools are all read-only vs a side-effecting tool).
- **Attempt semantics:** recovery marks the already-counted attempt interrupted — it never increments/decrements/resets `attemptCount` and never bypasses `max_attempts`. The next real dispatch increments (the G1 rule). If the budget was already exhausted, the G1 pass records `TASK_RETRY_EXHAUSTED` and the task stays failed.
- **Side-effect safety:** a task whose agent holds any non-read-only tool recovers as `INTERRUPTED_REVIEW_REQUIRED` — no automatic retry, no one-click retry (the UI shows "review required"; `retryTask` returns `HUMAN_ACTION_REQUIRED`). No force-retry bypass exists.
- **manager integration:** `managerStep` gained step **1b** — `recoverStaleRunningTasks` runs AFTER workflow reconcile (step 1) and BEFORE dependency/retry promotion and dispatch. One invocation, bounded, no loop/daemon/interval.
- **Workflow vs agent:** workflow tasks keep their existing durable reconciliation (`reconcileTask` → coordinator `reconcile` → stale flow-run `interrupted`); G2 recovery **skips** `executionKind==='workflow'` and only fills the agent-task gap. No workflow recovery logic is duplicated.
- **Surfaces:** the interruption class flows through the existing `GET /api/company-tasks/:id` `retry` decision + `lastFailure*` fields and the CLI `task show` / MissionsBoard failure line with **no new endpoint or command** — `task retry` already handles the safe case; the review-required case shows "review required" (no Retry button) and is rejected by the retry path.
- **DB:** none (the in-memory active set + existing `last_failure_*` columns suffice; no lease/heartbeat/scheduler table).
- **NOT in G2:** reassignment *(now delivered in G3, below)*, scheduler/daemon/interval, backoff, provider/tool fallback, GC/archive, mission `blocked` remodel, force-retry. A review-required interrupted task requires a manual operator decision (no built-in confirmed-recovery action yet) — a G3 follow-on.

---

## G3 — IMPLEMENTED (controlled agent reassignment)

- **Agent-specific failure (conservative, provable):** the currently-assigned agent is no longer in the task's eligible set per the canonical resolver (`resolveAgentsForCapabilities` — removed / retired / lost a required wired tool), while at least one OTHER agent still is. A still-eligible agent that hit a shared/transient failure is **not** agent-specific → same-agent G1 retry (no rotation). Model/provider-outage and repeated-failure-while-eligible heuristics are deliberately excluded (would risk provider fallback / guessing) — G4 candidates.
- **Reassignment eligibility (ALL required):** task is `failed` + assigned; attempt budget remains; failure is safe to repeat (G1/G2 `isTaskAutoRetrySafe`); failure is not human-action (approval/permission/config/invalid/gap → never reassigned around); the assigned agent is no longer eligible; and there is another agent that satisfies EVERY required capability AND every required wired tool via the **one canonical resolver** (never a second engine, never a relaxed check). No alternate ⇒ `NO_ALTERNATE_AGENT`, task stays failed (no Agent-Factory auto-create).
- **Decision service** (`lib/company/manager/reassign.ts`): pure `decideReassignment` (states `REASSIGN_ALLOWED` · `NO_ALTERNATE_AGENT` · `FAILURE_NOT_AGENT_SPECIFIC` · `RETRY_EXHAUSTED` · `UNSAFE_TO_REPEAT` · `HUMAN_ACTION_REQUIRED` · `NOT_APPLICABLE`, no DB), `evaluateReassignment` (read-only resolve of the canonical facts), `reassignTaskIfWarranted` (mutating), `reassignAgentSpecificFailures` (manager pass).
- **Candidate selection:** deterministic — the canonical resolver rank + the canonical `selectAgent` (first non-busy in rank order, else top-ranked), over the alternates with the **failed agent excluded** (scoped to this decision — no global blacklist). No random, no invented "AI score".
- **Attempt semantics:** reassignment reuses the shared controlled `failed → queued` transition (`moveFailedToQueued`) and NEVER touches `attemptCount`; the next real dispatch increments it (the G1 rule). `max_attempts` still binds (exhausted ⇒ `RETRY_EXHAUSTED`, no reassignment).
- **History preservation:** the prior agent's `agent_runs` row and the `TASK_ASSIGNED`/`AGENT_STARTED`/`TASK_FAILED` events remain; the new assignee is set via `assignTask` (capability-compat-checked) and a single `TASK_REASSIGNED` event records `from`/`to`/attempt/class/candidateCount/reason.
- **Side-effect + approval safety:** unchanged from G1/G2 — an unsafe (possible external side effect) or approval/human-action failure is never auto-reassigned (`UNSAFE_TO_REPEAT` / `HUMAN_ACTION_REQUIRED`). No force flag. Provider-switching is never smuggled in (a still-eligible agent is not rotated); tool substitution is impossible (the resolver requires the exact wired tool).
- **manager integration:** `managerStep` step **1c** — reassignment runs after workflow reconcile (1) + G2 recovery (1b) and BEFORE the G1 same-agent retry pass; a reassigned task is already `queued`, so G1 skips it and the dispatch loop runs the new agent (incrementing the attempt once). One bounded pass, no loop/daemon/interval.
- **Surfaces:** additive read-only `reassignment` decision on `GET /api/company-tasks/:id` (failed tasks) + CLI `task show`; the MissionsBoard task row already reflects a completed reassignment via its agent (`→ B`) + attempt (`att 2/3`) badges. No new endpoint/command (the Manager auto-reassigns), no explicit force-target path.
- **DB:** none.
- **NOT in G3:** provider/tool fallback, Agent-Factory auto-create, scheduler/backoff/timers, reassignment loop, mission `blocked` remodel, GC. Repeated-failure-while-still-eligible reassignment and disabled-but-capability-holding exclusion are G4 candidates.

---

## G4 — IMPLEMENTED (deterministic retry backoff)

- **Scope:** a durable, deterministic wait between automatic retries of a **transient** failure. It does NOT widen the auto-retryable set (the G1 classifier + `isTaskAutoRetrySafe` still decide *whether* a failure may auto-retry); it only decides *when*. There is **no** background scheduler, daemon, cron, polling loop, backoff timer, or `setInterval`/`setTimeout` — "wait until due" is a value checked on the next bounded `managerStep`, exactly like G1 retry.
- **Backoff-eligible classes (only):** `TRANSIENT_PROVIDER_ERROR`, `PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`, `CONNECTOR_UNAVAILABLE`. **Excluded on purpose:** `EXECUTION_INTERRUPTED` (a G2 process-restart interruption is manager-recovered on the very next tick — no provider-style delay), and every human-action / non-auto class (config, gap, permission, approval, invalid, review-required, unknown, permanent) which gets no auto-retry and therefore no timer.
- **Policy (pure, no randomness):** `computeRetryDelayMs({ failureClass, attemptCount, maxAttempts })` in `lib/company/manager/failure.ts` — bounded exponential from a 15s base, doubling per started attempt, capped at **60s**: attempt 1 → 15s · attempt 2 → 30s · attempt ≥3 → 60s. Non-eligible class ⇒ `0`. No jitter (deterministic tests, no wall-clock sleeps). Constants `RETRY_BACKOFF_BASE_MS` / `RETRY_BACKOFF_MAX_MS`.
- **Durable timing:** additive nullable `company_tasks.next_retry_at TEXT` (`CompanyTask.nextRetryAt`). `NULL` = no scheduled automatic-retry delay (also the value for non-auto, exhausted, completed, and reassigned tasks). A timestamp = auto-retryable but must not be promoted before that instant. Additive + idempotent DDL/migration; older rows load unchanged (`NULL` = due immediately). No new scheduler/retry-job table.
- **Scheduling (on failure):** `recordTaskFailure` sets `next_retry_at = now + delay` **only** for a backoff-eligible, side-effect-**safe**, still-within-budget failure, and emits **one** `TASK_RETRY_SCHEDULED` event (safe metadata: class, attempt, maxAttempts, delayMs, nextRetryAt). Unsafe/approval/exhausted/interrupted ⇒ `next_retry_at` stays `NULL`, no event.
- **Promotion (due-gated):** `promoteRetryableFailures(db, missionId, { now })` skips a failed task while `now < next_retry_at` (`isRetryDue`) — it stays `failed`, **consumes no attempt**, emits no event (no scheduling spam on repeated ticks). At/after due it does the controlled `failed → queued` (which **clears** `next_retry_at`), then the dispatch loop runs it and increments the attempt exactly once.
- **Clear rules (defined + tested):** `next_retry_at` is cleared whenever the task leaves `failed` toward execution — the shared `moveFailedToQueued` clears it for the G1 auto path, the G1 explicit path, **and** the G3 reassignment path — so a reassigned task queues immediately (a stale provider backoff never re-delays the new agent), and completion carries `NULL`.
- **Explicit vs automatic retry:** automatic retry obeys `next_retry_at`. An **explicit operator retry** (`retryTask`, API/CLI/UI button) **may run early** ("operator acknowledged early retry") — but still cannot bypass `max_attempts`, side-effect safety, approval, non-retryable classification, eligibility, or tool preflight. No `force=true` flag exists.
- **Time source:** the smallest injectable clock — `recordTaskFailure`, `promoteRetryableFailures`, and `managerStep` accept an optional `{ now }` (default real clock); pure helpers (`computeRetryDelayMs`, `isRetryDue`) take `now`/attempt directly. Tests drive all timing with the injected clock — **no real sleeps**.
- **manager integration:** unchanged order — workflow reconcile (1) → G2 recovery (1b) → G3 reassignment (1c) → **G1/G4 retry promotion (2b, now due-gated)** → dispatch (3). One bounded pass.
- **Surfaces:** additive read-only `retryTiming` (`nextRetryAt`/`retryDue`/`retryAfterMs`, derived at read time) on `GET /api/company-tasks/:id`; CLI `task show` shows "Next retry: due now" or the timestamp + `in Ns`; MissionsBoard shows a static (non-ticking) "retry scheduled · available <time>" / "retry ready" badge that a normal page refresh updates. No scheduler command, no new endpoint; CLI stays HTTP-only.
- **DB:** one additive nullable column (`next_retry_at`). No new table.
- **NOT in G4:** background scheduler/daemon/cron/timer, provider fallback, tool fallback, repeated-failure agent rotation, Agent-Factory auto-create, jitter, GC/archive, mission `blocked` remodel, RBAC, chat console.

---

## 0. What G0 changed

- **Fixed the 2 flaky tests** (targeted per-test timeouts on the two proven-stable, first-touch-heavy tests — see `tests/seed.test.ts` "no-larp" and `tests/api.test.ts` "GET /api/agents"). No global timeout change, no skipped tests, no weakened assertions. Suite is now **1685/1685, green across 3 consecutive full runs**.
- **Documented this baseline.** No behavior change to the runtime.

---

## 1. Current execution lifecycle (code-verified)

```
Mission (company_missions)
  └─ managerStep(db, missionId)                      lib/company/manager/service.ts:36
       1. reconcile running WORKFLOW tasks           → reconcileTask()      delegation.ts:235
       2. promote waiting_dependency → queued        (transition-guarded)   service.ts:50
       3. dispatch ≤ maxSteps actionable tasks       → dispatchTask()       delegation.ts:77
       4. deriveMissionComplete → mission completed   manager/model.ts:256
            └─ retireTemporaryAgents (F2)             factory/service.ts

dispatchTask(db, taskId)                              delegation.ts:77
  ├─ idempotency: running|terminal → already_active   (line 82)
  ├─ dependency guard: unsatisfied → waiting_dependency(line 85)
  ├─ resolve target:
  │    eligible = resolveAgentsForCapabilities(...)   registry / capabilities
  │    presence refine (busy set)                     buildAgentPresence
  │    tool PREFLIGHT (taskToolGap)                   delegation.ts:47  → drops tool-deficient agent
  │    chooseDispatchTarget()                          manager/model.ts:223
  ├─ gap  → append CAPABILITY_GAP / tool_gap event; task STAYS queued   (line 120)
  ├─ workflow → dispatchWorkflow()                     (line 204)
  └─ agent    → dispatchAgent()                        (line 160)

dispatchAgent(db, task, agentId, runtime)            delegation.ts:160  [SYNCHRONOUS]
  assign → status assigned → status running
  events: TASK_ASSIGNED, TASK_DISPATCHED, AGENT_STARTED
  run = runtime.run(agentId)                          lib/agents/runtime.ts:64
  setExecution(task, 'agent', run.id)
  if run.ok:  createArtifact (dedup-guarded) → status completed → TASK_COMPLETED
  else:       status failed → TASK_FAILED (metadata.error = summary[:200])

dispatchWorkflow(db, task, workflowId)               delegation.ts:204  [FIRE-AND-FORGET]
  validate published immutable version (validateExecutable)
  status running
  run = flowRuns.create(...); startRun(...)           coordinator.ts:31 (background engine)
  setExecution(task, 'workflow', run.id)
  events: TASK_DISPATCHED, WORKFLOW_STARTED

runtime.run(id)                                       lib/agents/runtime.ts:64
  try { result = await agent.run() }
  catch (err) { result = { ok:false, summary: err.message } }   ← ERROR CODE DISCARDED
  insert agent_runs row {ok, summary, model, tokens, costUsd}

Workflow engine background path                       lib/flows/engine.ts + coordinator.ts
  startRun → executeRun (fire-and-forget)
    .catch → flowRuns.update(status:'failed', errorCode:'engine_error', errorMessage[:300])
  reconcile(runId): stale running (not in active set) → interrupted (errorCode:'interrupted')
```

**Model call path (from an agent/executor):** `routeModel(db, settings, req)` → `normalizeAdapterError` → typed `ModelRouteError` (codes below). **No silent fallback** — a failed model throws.

---

## 2. Failure points (where a failure originates)

| # | Point | File:fn | Current behavior on failure |
|---|---|---|---|
| FP-1 | Model/provider call | `lib/models/router.ts` `routeModel`/`normalizeAdapterError` | Throws typed `ModelRouteError(code)` — `auth_failed`, `rate_limited`, `model_unavailable`, `network_error`, `provider_unavailable`, `provider_not_configured`, `provider_disabled`, `credential_missing`, `invalid_base_url`, `auto_not_implemented`, `hermes_unavailable`, `model_capability_mismatch` |
| FP-2 | Agent `run()` (built-in/custom) | `lib/agents/runtime.ts:69` | try/catch collapses **any** throw → `{ok:false, summary}` — **the `ModelRouteError.code` is lost** |
| FP-3 | Agent dispatch outcome | `delegation.ts:196` | `run.ok===false` → task `failed`, event `TASK_FAILED metadata.error=summary[:200]` |
| FP-4 | Workflow node executor | `lib/flows/executors/*`, `engine.ts` | Node `failed` (redacted `error_code`/`error_message` in `flow_node_runs`); downstream skipped; run `failed` |
| FP-5 | Workflow engine crash | `coordinator.ts:34` | run → `failed` (`engine_error`) |
| FP-6 | Workflow reconcile (stale) | `coordinator.ts:74` | stale `running` → `interrupted` |
| FP-7 | Workflow→task reconcile | `delegation.ts:260` | `failed`/`interrupted` run → task `failed` (`metadata.runStatus`) |
| FP-8 | Tool/connector call | connectors (e.g. `websearch.ts`), Hermes tools | Honest error surfaced up as a throw → FP-2/FP-4 |
| FP-9 | Capability/tool gap | `delegation.ts:120` | Task **stays queued**; `CAPABILITY_GAP` event with `reason: capability_gap | tool_gap | no_target` |
| FP-10 | Human approval pause | `reconcileTask` `delegation.ts:265` | task `waiting_approval` + `APPROVAL_REQUIRED` (Phase E authoritative) |

---

## 3. Current stuck-state causes (why missions get stuck — finding H1)

| Cause | Mechanism | Evidence |
|---|---|---|
| **`failed` is terminal — no retry** | `TASK_TRANSITIONS.failed = []` (`lib/company/model.ts:151`). A failed task can never return to `queued`/`running`. | Dev DB: 2 failed tasks, permanently. |
| **One failed task blocks the whole mission forever** | `deriveMissionComplete` returns false if ANY non-cancelled task is `failed` (`manager/model.ts:259`). Mission never auto-completes. | Missions with a failed subtask sit `active` indefinitely. |
| **Capability/tool gap keeps a task queued indefinitely** | `dispatchTask` returns `capability_gap` and never advances; no operator nudge. `research.web` without a `web.search` agent + `TAVILY_API_KEY` = permanent queue. | Dev DB: 12 queued tasks incl. `research.web`. |
| **Agent task stuck `running` after a server restart** | `reconcileTask` only reconciles `executionKind === 'workflow'` (`delegation.ts:237`). An agent run is **synchronous, in-process, with no active-set tracking** — a restart mid-`runtime.run` leaves the task `running` with no reconciler. | Structural gap (no agent-run stale recovery). |
| **`waiting_dependency` never promoted without a manager step** | Promotion happens only inside `managerStep` step 2; nothing polls. | Requires a manual/triggered step. |
| **Workflow-task completion needs a manager step** | Fire-and-forget run completes, but the task only syncs on the next `reconcileTask`/`managerStep`. | Task reads `running` until reconciled. |

---

## 4. Failure classification design (G1 taxonomy — NOT implemented)

Reuse existing codes; do **not** create a parallel error system. The taxonomy maps the existing `ModelRouteError` codes + flow `error_code`s + gap reasons into a small classifier.

| Class | Maps from (existing codes) | Retryable | Auto-retry allowed | Reassign allowed | Human action required |
|---|---|---|---|---|---|
| `TRANSIENT_PROVIDER_ERROR` | `network_error`, `provider_unavailable`, `engine_error`, `interrupted` | Yes | Yes (bounded) | No (same target) | No |
| `PROVIDER_RATE_LIMIT` | `rate_limited` | Yes | Yes (backoff) | No | No |
| `PROVIDER_TIMEOUT` | Hermes `hermes_unavailable` (timeout), adapter timeouts | Yes | Yes (bounded, +cancel — INC-005) | Maybe (other agent/brain) | No |
| `CONNECTOR_UNAVAILABLE` | connector honest-fail (e.g. Tavily provider error) | Yes | Yes (bounded) | Maybe | No |
| `TOOL_CONFIGURATION_MISSING` | `credential_missing`, `invalid_base_url`, `provider_not_configured`, `provider_disabled`, tool `tool_gap` | No | No | Maybe (agent with a wired tool/key) | **Yes** (set key/connect) |
| `CAPABILITY_GAP` | dispatch `reason: capability_gap`/`no_target` | No | No | N/A | **Yes** (F2 propose agent) |
| `PERMISSION_DENIED` | Phase-E reject / `hermes_approval_required` denied | No | No | No | **Yes** |
| `APPROVAL_REQUIRED` | `waiting_approval`, `APPROVAL_REQUIRED` | No (paused, not failed) | No | No | **Yes** (approve/reject) |
| `MODEL_CAPABILITY_MISMATCH` | `model_capability_mismatch` | No | No | Maybe (capable model/agent) | **Yes** (choose capable model) |
| `INVALID_INPUT` | validation throws (`validateExecutable`, Zod) | No | No | No | **Yes** (fix definition/input) |
| `PERMANENT_TASK_FAILURE` | deterministic non-retryable agent failure | No | No | Maybe | **Yes** |
| `UNKNOWN_RUNTIME_FAILURE` | `node_error`, any unmapped `{ok:false}` | Once (conservative) | Configurable, default No | No | **Yes** (surface) |

**Classifier location (G1):** a pure `classifyFailure(code, context)` in `lib/company/manager/` (or `lib/reliability/`), fed by a **preserved error code** (see IP-1). No new store; the class is derived, persisted on the attempt row/event metadata only.

---

## 5. Retry / recovery integration plan (G1 — NOT implemented)

Desired future behavior: attempt → failure → classify → (retry if retryable+budget) → (reassign if agent-specific & another eligible agent) → (block if human/config) → preserve attempts → never silent provider/tool fallback → never duplicate artifacts/side effects.

**Definitions to add in G1:**

- **Attempt identity:** `(taskId, attemptNumber)`. Persist per-attempt on `company_events` metadata + the existing `agent_runs`/`flow_runs` refs (no new table if the attempt counter can live on `company_tasks` as an additive column + event ledger). *Minimize schema: prefer a single additive `attempt`/`retry_count` column over a new table.*
- **Retry budget:** per-task max attempts (default e.g. 2–3), configurable; stored on the task or a policy constant. Exhausted budget → terminal `failed` with a clear reason.
- **Backoff:** exponential with jitter for `TRANSIENT_*`/`RATE_LIMIT`; capped. Because dispatch is currently synchronous + manager-step-driven, backoff = "eligible for retry after T" checked on the next `managerStep` (no background scheduler in G1).
- **Idempotency boundary:** the **artifact dedup guard already exists** (`companyEvents.countForTask(taskId,'ARTIFACT_CREATED')===0`). Retry must keep one artifact per *successful* execution, and must NOT re-run an agent whose prior attempt had an **external side effect** unless the operation is known-idempotent — G1 needs a per-tool "side-effecting?" flag or an approval gate before retrying side-effecting tools.
- **Artifact deduplication rule:** unchanged — one `ARTIFACT_CREATED` per task; retries that fail create none.
- **State transitions (schema change required):** add `failed → queued` (or a new `retry_pending`) and `failed → assigned` to `TASK_TRANSITIONS`. This is the **one likely-unavoidable model change**; keep it additive and guarded.
- **Event history:** add `TASK_RETRY_SCHEDULED`, `TASK_RETRYING`, `TASK_REASSIGNED`, `TASK_BLOCKED` (+ reason/class) to `COMPANY_EVENT_TYPES` (additive enum, no schema migration — events are JSON). Preserve all prior attempts in the append-only ledger.
- **UI state needed:** MissionsBoard — show attempt count, failure class, "retryable/blocked" badge, a manual **Retry** and **Reassign** control (operator-gated), and the specific reason. Intelligence `repeated_failure` signal already exists; extend evidence with class.
- **CLI state needed:** `igris task show` — attempts + class + retryable; `igris task retry <id>` (preview→confirm, cannot bypass Phase-E).

---

## 6. Restart risks (current)

| Path | Restart behavior | Risk |
|---|---|---|
| Workflow run `running` | `reconcile` → `interrupted`; `reconcileTask` → task `failed` | Handled (honest) |
| Workflow run `waiting_approval` | Survives restart; reconciler ignores it (Phase E) | Handled |
| **Agent task `running`** | **No reconciler** (`reconcileTask` handles workflow only); synchronous run had no active-set tracking | **STUCK `running` forever** — G1 IP-4 |
| Draft/version/def | Immutable; unaffected | Safe |
| `managerStep` mid-tick | Not transactional across tasks; a crash mid-loop leaves partially-dispatched state | Low (idempotent re-dispatch guards) but no atomic tick |

## 7. Idempotency risks (current)

- **Safe / guarded:** re-dispatch of running/terminal task (guarded); artifact creation (event-count guarded); workflow approval resolve (conditional `WHERE status='pending'`); mission completion (status-checked).
- **Unsafe for blind retry:** an agent `run()` with an **external side effect** (send email, write, spend) — there is no side-effect ledger, so re-running could duplicate. Workflow re-dispatch creates a **new** `flow_runs` row each time (fine while guarded by task status, but a manual re-dispatch after `failed` would create a second run + potential duplicate side effects).
- **Event ledger** is append-only best-effort — safe (never canonical state), but retries must not be inferred from event replay (status authority stays canonical).

## 8. Exact G1 integration points

| ID | File:fn | Change (G1) | Notes |
|---|---|---|---|
| **IP-1** | `lib/agents/runtime.ts:64` `run()` | **Preserve the error code** — capture `err.code` (ModelRouteError/NodeExecError) onto `AgentRunResult`/`AgentRun` (additive field), don't collapse to summary-only | The single highest-value change; unblocks classification. Additive column on `agent_runs` or event metadata. |
| **IP-2** | `lib/company/manager/delegation.ts:196` `dispatchAgent` (fail branch) | On failure, **classify** (IP-1 code) and decide retry/reassign/block instead of unconditional `failed` | Reuse `classifyFailure`; emit new events |
| **IP-3** | `lib/company/model.ts:144` `TASK_TRANSITIONS` | Add `failed → queued`/`assigned` (or `retry_pending`) — **the likely-unavoidable schema/model change** | Keep additive + guarded; preserves terminal semantics only when budget exhausted |
| **IP-4** | `lib/company/manager/delegation.ts:235` `reconcileTask` + `lib/flows/coordinator.ts` | Add **agent-run stale recovery** (track agent dispatch in an active set / mark `running` agent tasks stale after restart) | Mirror the workflow `active`-set + `reconcile` pattern (INC-001/D11: `globalThis` singleton) |
| **IP-5** | `lib/company/manager/service.ts:60` `managerStep` step 3 | Include **retry-eligible** tasks (backoff-elapsed) in the dispatch loop | Backoff checked here (no background scheduler in G1) |
| **IP-6** | `lib/company/manager/model.ts:256` `deriveMissionComplete` | Optionally treat a **retry-exhausted** task as a hard blocker vs a retryable one (mission `blocked` vs stuck) | Consider `MISSION_TRANSITIONS` already supports `active → blocked` |
| **IP-7** | `lib/company/manager/model.ts:96` `COMPANY_EVENT_TYPES` | Add retry/reassign/block event types (additive enum) | No migration (events are JSON) |
| **IP-8** | `lib/models/router.ts` | (Already correct) keep no-silent-fallback; classifier consumes the codes | No change to fallback policy |
| **IP-9** | `components/MissionsBoard.tsx`, `lib/cli/commands/company.ts` | Surface attempts/class/retry controls | UI/CLI only |

## 9. Recommended implementation order (for G1, later)

1. **IP-1** preserve the agent error code (additive, low risk) + a pure `classifyFailure`.
2. **IP-4** agent-run stale-recovery on restart (fixes the worst stuck state; mirrors existing workflow pattern).
3. **IP-3** additive `failed → queued`/`retry_pending` transition + attempt counter (the one schema touch).
4. **IP-2/IP-5** bounded retry (budget + backoff-on-next-step) with the artifact/side-effect idempotency guards.
5. Reassignment to another eligible agent for agent-specific classes.
6. **IP-9** UI/CLI surfacing (retry/reassign/blocked + reason).
7. **IP-6** mission `blocked` vs stuck semantics.

## 10. Non-goals (explicitly NOT in G0, and constraints for G1)

- **G0 builds no runtime behavior** — this is prep only.
- No background scheduler / queue / Redis (retry is checked on `managerStep`, consistent with the current in-process model).
- No silent provider/tool fallback (invariant 15/32 preserved — retry is same-target or explicit reassign, never a quiet different provider).
- No duplicate artifacts or duplicate external side effects.
- No autonomous/unbounded loop (bounded step preserved).
- No RBAC, no chat/operator console, no legacy cleanup, no mass GC.
- Minimize schema: prefer one additive column + additive event enum over new tables; only `TASK_TRANSITIONS` + an `attempt`/`retry_count` column are expected to be unavoidable.
