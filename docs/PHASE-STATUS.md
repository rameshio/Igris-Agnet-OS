# PHASE-STATUS — what is LIVE / PLANNED / LEGACY

> Truthful status of every feature, grounded in the current code. Status keys:
> **LIVE** (implemented + tested) · **PARTIAL** · **PLANNED** (not built) ·
> **LEGACY** (kept for backward compatibility only).

## Phase history

### Phase A — Workflow foundation ✅ complete
- **Purpose:** make `/flows` a real, typed, versioned workflow system (definition only, no execution).
- **Major changes:** typed discriminated node schema; typed edges; editable draft + immutable versions; validator v1; node executor registry (config-only); multiple named workflows; import of the legacy `agent_flows` "main" canvas into `wf-main`.
- **Files:** `lib/flows/schema.ts`, `node-types.ts`, `registry.ts`, `validator.ts`; `app/api/flows/{route,[id]/route,[id]/versions/route}.ts`; `app/flows/page.tsx`; `components/flows/{FlowWorkspace,FlowCanvas}.tsx`.
- **DB:** `flow_workflows`, `flow_versions`.
- **Decisions:** dedicated `/flows` route; draft-vs-immutable-version; DAG-only; unsupported nodes shown honestly.
- **Limitations:** nothing executes yet.

### Phase B — Unified model runtime ✅ complete
- **Purpose:** one app-wide model architecture usable by agents, Conductor, and (later) the workflow engine.
- **Major changes:** `ModelRouter` with strategies `fixed | hermes | auto`; provider catalog widened (Google, NVIDIA, Ollama, custom OpenAI-compatible); per-agent model config UI; provider connections (enable/disable/base-URL/status); model badges on flow agent nodes; per-agent chat routed through the router.
- **Files:** `lib/models/{types,settings,connections,router,catalog,resolve}.ts`; `lib/connectors/openai-compatible.ts`; `app/api/models/route.ts`; `components/{ModelsBoard,AgentBuilder}.tsx`; `lib/agents/chat.ts`.
- **DB:** `model_provider_connections` (metadata/status only — never the secret).
- **Decisions:** Hermes stays a first-class brain (not an API-key card); Auto is a safe stub; strategy encoded in the existing agent `model` string (zero-migration).
- **Limitations:** fixed direct providers are text-only (no tool-calling); Auto not implemented; no fallback.

### Phase C — Execution engine + Run Inspector ✅ complete
- **Purpose:** make published workflow versions actually execute, persisted and inspectable.
- **Major changes:** backend `WorkflowEngine` (dependency order, typed state, fail-fast); executable `Input`/`Agent`/`Output` executors; in-process `FlowRunCoordinator` (fire-and-forget + poll); run/node-run persistence; execution-validity check; Run Inspector UI with canvas status overlay + run history + starting input + Run/Publish distinction.
- **Files:** `lib/flows/{run-types,errors,engine,coordinator}.ts`, `lib/flows/executors/*`; `app/api/flows/[id]/runs/route.ts`, `app/api/flows/runs/[runId]/route.ts`; `components/flows/FlowCanvas.tsx` (run UI).
- **DB:** `flow_runs`, `flow_node_runs` (+ 2 indexes).
- **Decisions:** run an immutable version (never a draft); runtime state never written into graph JSON; workflow output NOT auto-saved to G-Brain; polling not WebSockets; active-run registry pinned to `globalThis` (Next bundles routes separately).
- **Limitations:** sequential; only Input/Agent/Output executable; no fallback/retry/cancel; Hermes usage not captured (tokens null); stale runs reconciled to `interrupted` on read.

### Phase D — Logic nodes, mapping, branching, Parallel/Join ✅ complete
- **Purpose:** turn the Phase-C executable DAG into a real logic engine (structured data flow + branching) without replacing the engine.
- **Major changes:** canonical `{{Node.field}}` reference/template resolver (`references.ts`, prototype-pollution-safe, no `eval`); one condition schema + evaluator shared by Decision nodes and conditional edges (`conditions.ts`); node input resolution over ACTIVE edges with `all`/`field`/`template`/`object` mappings (`inputs.ts`); executable `Transform` (declarative reshape), `Decision` (first-match routes + default), `Parallel` (fan-out), `Join` (wait-for-all-active-branches); active-edge scheduler with skip-vs-fail and unreachable-node skipping; validator Phase-D checks; canvas node/edge inspectors + Run Inspector routes/skip.
- **Files:** `lib/flows/{references,conditions,inputs}.ts`, `lib/flows/executors/{transform,decision,parallel,join}.ts`, `components/flows/InspectorPanel.tsx`; modified `lib/flows/{schema,engine,registry,validator,node-types}.ts`, `executors/{index,agent}.ts`, `components/flows/FlowCanvas.tsx`.
- **DB:** none — logic lives in the version graph JSON; runtime detail in existing `flow_node_runs` JSON.
- **Decisions:** first-match exclusive Decision routing; ALL true conditional edges activate (Decision for exclusive); one condition evaluator; sequential Parallel (deterministic > concurrent); Join keys branches by stable label; missing references fail clearly (never silent-empty).
- **Limitations:** sequential execution; static ref validation checks the reference root only; optional/default reference values deferred (Phase G-ish).

### Phase E — Human Approval + durable pause/resume ✅ complete
- **Purpose:** let a workflow pause for a human, durably, and resume exactly where it stopped — without re-running any completed work. A human GATE, separate from the machine-logic Decision node.
- **Major changes:** `Human Approval` node type made runnable (engine-intercepted `approvalExecutor`); the engine gained a resumable scheduler — `handleApproval` opens a `pending` `flow_approvals` row and pauses (`waiting_approval`), `resumeRun(runId)` rebuilds `state`/`status` from persisted node runs and applies the human decision; Approval routes like a Decision (approve/reject `sourceHandle`); a rejection is a distinct `rejected` node status, NOT a failed run; idempotent conditional resolve (approve-twice = one execution); `resumeRunBg` reuses the `globalThis` active set as a resume lock; reconciler still ignores `waiting_approval` (survives restart). Approvals inbox page + Run Inspector waiting/resolved states + canvas approval config; Hermes approval events stay `hermes_approval_required` (never auto-answered; session continuation deferred).
- **Files:** `lib/flows/approvals.ts`, `lib/flows/executors/approval.ts`, `app/api/flow-approvals/**`, `components/ApprovalsInbox.tsx`, `app/approvals/page.tsx`; modified `lib/db.ts` (repo `flowApprovals`), `lib/flows/{run-types,schema,engine,coordinator,node-types}.ts`, `lib/flows/executors/index.ts`, `components/flows/{FlowCanvas,InspectorPanel}.tsx`, `app/api/flows/runs/[runId]/route.ts`, `lib/nav.ts`, `lib/connectors/hermes-serve.ts`.
- **DB:** additive `flow_approvals` table + 3 indexes (`CREATE TABLE IF NOT EXISTS`); run status gained `waiting_approval`, node status gained `rejected`. `context_json` is non-secret only. No existing table/column changed; immutable versions untouched.
- **Decisions:** see `docs/DECISIONS.md` D20 (durable gate separate from Decision; approve/reject routing; no upstream rerun; idempotency + resume lock; backend-authoritative endpoints; Hermes continuation deferred).
- **Limitations:** no approval expiry/TTL (`expired` status defined but unused); no auth layer (resolver actor `local_operator`); Hermes-session approval continuation deferred; sequential execution unchanged.

## Architecture V2 — company registry + company work model (runs alongside the product phases)

### V2-F0.1 — Company Registry — Capability layer ✅ complete
- **Purpose:** first-class capabilities (`domain.action`) over the existing agent registry + a deterministic resolver so the F1 Manager can find workers by capability.
- **Files:** `lib/agents/capabilities.ts`, `lib/db.ts` (additive), `lib/agents/registry.ts`, `app/api/capabilities/route.ts`, `app/api/agents/[id]/capabilities/route.ts`, `app/api/agents/resolve/route.ts`.
- **DB:** additive `capabilities` + `agent_capabilities` + index. No FK.
- **Limitations:** no built-in capability seeding; no derived inference; registry/data/resolution only — no execution.

### V2-F0.2 — Mission + Company Task canonical model ✅ complete
- **Purpose:** canonical company-work layer (Mission = objective, Company Task = work unit) DISTINCT from the existing `agent_tasks` kanban. Data model + services + narrow APIs + minimal Missions UI + F0.1 capability-assisted manual assignment + optional dependencies.
- **Major changes:** pure model (`lib/company/model.ts`) — types, Zod schemas, status enums + guarded transitions, graph helpers (parent-tree + dependency-DAG cycle guard), mission summary, prerequisite check. Service (`lib/company/service.ts`) — canonical create/read/update boundary composing repos + pure model + F0.1 resolver; CompanyError + HTTP status mapping. Missions Board UI + page.
- **Files:** `lib/company/{model,service}.ts`; `app/api/missions/{route,[id]/route,[id]/tasks/route}.ts`; `app/api/company-tasks/[id]/{route,assign/route,dependencies/route,eligible-agents/route}.ts`; `components/MissionsBoard.tsx`; `app/missions/page.tsx`.
- **DB:** additive `company_missions` + `company_tasks` + `company_task_dependencies` + 6 indexes. Cross-subsystem references validated in service, not FK.
- **Decisions:** see `docs/DECISIONS.md` (Mission ≠ agent_tasks; F0.2 stores + organizes only; manual assignment is capability-compat-checked; dependencies same-mission + acyclic; workflow/run seams validated but never executed; no auto-completion).
- **Limitations:** no planning/decomposition/auto-assignment/delegation/execution (F1); no approval integration from `waiting_approval` status; no pagination; no soft-delete.

## HRA-2 — Hermes Runtime Architecture V2 (runs alongside the product phases)

A staged migration of the Hermes integration from the ACP stdio process toward Hermes's own
`serve` (WS + JSON-RPC) runtime. The review recommends H1–H3 land **before Phase E**.

- **H0 — serve protocol/capability spike** ✅ — verified `hermes serve` v0.20.0 live (transport, health, sessions, streaming, cancel+recovery, multi-client, tools, memory). Decision: **GO WITH CONDITIONS**.
- **H1 — HermesClient seam + serve test spike** ✅ (LIVE) — `lib/connectors/hermes-client.ts` (`chat`/`health`/`capabilities`, tri-state) wraps the active brain (ACP in prod, zero behavior change); the ModelRouter `hermes` path calls it. Test-only `lib/connectors/hermes-serve.ts` implements the H0 serve protocol against a fake fixture. **ACP remains primary; serve is disabled.**
- **H2 — runtime discovery/health/lifecycle** ✅ (LIVE) — `HermesRuntimeManager` (`lib/connectors/hermes-runtime.ts`): binary discovery (validated by `--version`), `/api/status` health, runtime state/mode/ownership, PID-exact managed start/stop (never `serve --stop`/external). `GET/POST /api/settings/hermes-runtime` + Settings ▸ Hermes Runtime panel. Non-secret config in `meta`; token in `.env.local` only. **Still ACP transport.**
- **H3 — serve as a SELECTABLE production transport** ✅ (GO WITH CONDITIONS, live-validated) — `getHermesClient(db)` selects serve vs the active brain from `meta.hermes_production_transport` (default `acp`); eligibility-gated flip; **no silent fallback**; one isolated session per node run; bounded concurrency (default 3); layered timeouts + interrupt; approval events → `hermes_approval_required`. Live: Gmail workflow succeeded (~114s) with the health channel healthy throughout, Transform/Output ran, no ACP poisoning; ACP rollback works. **Serve is NOT the default** — ACP remains default.
- **H4 — remote Hermes · H5 — retire ACP as app transport** ▶ next / ○.

**Conditions before serve could become a default (H4+):** MCP-specific execution over serve not isolated (server-side tools incl. real email DID run) → MCP partial; skills `unverified`; persistent-memory isolation via a dedicated Hermes profile is a pending product decision; true-parallel confirmed (sessions independent).

## Planned phases (NOT built — do not implement unless instructed)

- **Phase F — Memory:** explicit G-Brain read/write nodes, controlled knowledge promotion. (Still: no auto-save.)
- **Phase E follow-ons (NOT built):** approval expiry/TTL, an auth layer (resolver actor is `local_operator`), Hermes-session approval continuation, and using the Human Approval node to gate destructive/external actions inside executors.
- **Phase G — Reliability:** retries, error routes, recorded model fallback, cancellation, workflow recovery, versioning polish.

## Feature status matrix

| Feature | Status | Where | Notes |
|---|---|---|---|
| Agent CRUD (custom) | LIVE | `lib/agents/custom.ts`, `app/api/agents/*` | Built-ins are code-defined (`real.ts`) |
| Per-agent chat | LIVE | `lib/agents/chat.ts` | Routes through ModelRouter |
| Conductor operator mode | LIVE | `lib/agents/conductor.ts` | Confirm-each actions; `@agent` delegation |
| Per-agent model strategy | LIVE | `lib/models/settings.ts`, `AgentBuilder.tsx` | fixed / hermes / auto(stub) |
| ModelRouter | LIVE | `lib/models/router.ts` | fixed/hermes; auto → error |
| Hermes routing (ACP) | LIVE | `lib/connectors/hermes-acp.ts` | Persistent process |
| Direct provider routing | LIVE | `lib/connectors/openai-compatible.ts` | OpenAI/Anthropic/xAI/DeepSeek/Groq/Mistral/OpenRouter/Together/Google/NVIDIA |
| Ollama / local | LIVE | catalog `ollama` | Keyless, base-URL override |
| Custom OpenAI-compatible | LIVE | catalog `custom` | User base URL, optional key |
| Provider connect/test/enable/disable | LIVE | `app/api/models/route.ts`, `ModelsBoard.tsx` | Real backend check |
| Auto Router (intelligent) | PLANNED (D+/telemetry) | — | Currently a safe stub |
| Model fallback | PLANNED Phase G | — | Never silent; result type reserves `fallbackUsed` |
| Flow draft save | LIVE | `app/api/flows/[id]/route.ts` PATCH | Non-blocking validation |
| Flow publish / versioning | LIVE | `app/api/flows/[id]/versions/route.ts` | Immutable snapshots |
| Input → Agent → Output execution | LIVE (Phase C) | `lib/flows/engine.ts`, `executors/*` | Sequential, DAG |
| Run persistence + Run Inspector | LIVE (Phase C) | `flow_runs`/`flow_node_runs`, `FlowCanvas.tsx` | Poll ~1s |
| Canvas run-status overlay | LIVE (Phase C) | `FlowCanvas.tsx` | From run state, not definition |
| Decision / Transform / Parallel / Join | LIVE (Phase D) | `lib/flows/executors/{decision,transform,parallel,join}.ts` | Machine logic; deterministic |
| `{{Node.field}}` references + templates | LIVE (Phase D) | `lib/flows/references.ts` | Safe path lookup, no eval, proto-guarded |
| Condition evaluator (Decision + edges) | LIVE (Phase D) | `lib/flows/conditions.ts` | One evaluator; 14 operators |
| Edge mapping (all/field/template/object) | LIVE (Phase D) | `lib/flows/inputs.ts`, `schema.ts` | Type-preserving whole-refs |
| Conditional edges + skip-vs-fail | LIVE (Phase D) | `lib/flows/engine.ts` | Active-edge scheduler |
| Human approval (durable pause/resume) | LIVE (Phase E) | `lib/flows/{approvals,engine}.ts`, `flow_approvals`, `app/api/flow-approvals/*`, `ApprovalsInbox.tsx` | Idempotent; survives restart; no upstream rerun; routes like Decision |
| Memory nodes | PLANNED Phase F | — | No auto-save today |
| Retries / error routes / cancel | PLANNED Phase G | — | Fail-fast only today |
| Company Missions + Tasks (V2-F0.2) | LIVE | `lib/company/*`, `/api/missions/*`, `/api/company-tasks/*`, `MissionsBoard.tsx` | Data + organizing only; distinct from `agent_tasks` |
| Capability-assisted manual assignment (V2-F0.2) | LIVE | `lib/company/service.ts` `assignTask` | F0.1 resolver `mode: all`; 409 if incompatible |
| Task dependencies (V2-F0.2) | LIVE | `lib/company/service.ts`, `/api/company-tasks/:id/dependencies` | Same-mission, acyclic, idempotent; read-only `prerequisitesSatisfied` |
| Eligible-agent resolution (V2-F0.2) | LIVE | `/api/company-tasks/:id/eligible-agents` | F0.1 resolver over task's required capabilities |
| Legacy Agent Flow canvas + API | LEGACY | `AgentFlowCanvas.tsx`, `/api/agent-flows`, `flow-run.ts` | Kept for compat; not surfaced on `/brain` |

## Architectural invariants — DO NOT BREAK

1. `/brain` is knowledge, not execution.
2. `/flows` is orchestration, not the knowledge graph.
3. Flow nodes **reference** agents (they do not own model credentials/config).
4. Agents own their **default** model strategy.
5. Model provider connections are **app-wide** (`model_provider_connections`), not flow-specific.
6. **Hermes is a first-class brain/runtime**, not just another API-key provider card.
7. Workflow **drafts are editable**.
8. Published workflow **versions are immutable**.
9. **Runs reference immutable versions** — later draft edits never change an existing run's meaning.
10. **Runtime state is never written into workflow definition JSON.**
11. Workflow outputs are **not** automatically permanent G-Brain memory.
12. **Provider secrets never** live in readable DB rows or frontend responses.
13. **Legacy flow code remains** until explicitly retired (see `LEGACY.md`).
14. Unsupported future node types **must not pretend to execute** — they are rejected pre-run and labeled with their phase.
15. **Model fallback must never happen silently** (and is not implemented yet).
16. A **Human Approval** node pauses a run durably (`waiting_approval`) and resumes via `resumeWorkflowRun` on an immutable version WITHOUT re-running succeeded nodes; resolution is idempotent (conditional `WHERE status='pending'`) and backend-authoritative (client sends only id+decision+note). Nothing auto-approves — not Approval nodes, not Hermes `approval/sudo/secret.request`. A `waiting_approval` run must never be reconciled to `interrupted`. (Using approval to gate destructive executor side effects is a Phase-E follow-on, not yet built — still do not add unattended destructive side effects.)
17. Use the **repository layer**; pages/routes never touch SQLite directly.
18. Use the **executor registry** and the **ModelRouter**; do not scatter `switch (node.type)` or per-provider calls.
19. **One reference resolver** (`references.ts`) and **one condition evaluator** (`conditions.ts`) — never a second `{{...}}` parser or condition engine. No `eval`/`Function`/dynamic code in workflow logic.
20. **Missing references fail clearly** (`workflow_reference_not_found`) — never silently substitute empty/undefined. Reference lookup is read-only and rejects `__proto__`/`prototype`/`constructor`.
21. **Decision is machine logic** (deterministic, no LLM by default); Human Approval (Phase E) is the separate human gate. A node reachable by no ACTIVE edge is **skipped, not failed**; a node that errors while executing is **failed**.
22. **Transform is declarative only** — data reshape via references; never arbitrary scripting.
23. **Company Tasks are NOT agent_tasks.** The `company_missions`/`company_tasks`/`company_task_dependencies` schema (F0.2) is a SEPARATE system from the existing lightweight `agent_tasks` kanban. F0.2 code NEVER reads, writes, renames, or migrates `agent_tasks` data. The two coexist — `/tasks` is the kanban, `/missions` is the company-work layer.
24. **F0.2 stores and organizes work only.** It does NOT plan, decompose, auto-assign, delegate, or execute. `workflowId` is a reference seam; `runId` is F1's execution seam; `waiting_approval` never creates a `flow_approvals` row. That is F1.
