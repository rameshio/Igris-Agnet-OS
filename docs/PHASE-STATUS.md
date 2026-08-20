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

### V2-F1 — Executive Manager / Delegation Engine ✅ complete
- **Purpose:** make the company operable — an Executive Manager (the evolved Conductor) plans a Mission, decomposes it into Company Tasks, capability-matches (F0.1), and delegates to an existing agent OR an existing published workflow, with Artifacts + an event ledger + a report. Bounded, durable, deterministic, human-triggered. Evolves existing systems — NO parallel engine.
- **Major changes:** `role: 'executive_manager'` on the Conductor (registry `getExecutiveManager`); manager service (`lib/company/manager/{model,planning,delegation,service,artifacts,events}.ts`) — closed action allow-list, schema-validated planning (server-generated task ids, idempotent apply), deterministic dispatch policy (published workflow > eligible agent > capability_gap), agent dispatch via `createRuntime(...).run` + workflow dispatch via `startRun` (published version only) + `reconcileTask`, first-class Artifact + append-only event ledger, bounded `managerStep`, deterministic `missionReport`. Missions Board gains manager controls + report + events.
- **Files:** `lib/company/manager/*` (6); `app/api/missions/[id]/{plan,manager-step,report,events}/route.ts`; `app/api/company-tasks/[id]/dispatch/route.ts`; `app/api/company-artifacts/[id]/route.ts`; modified `lib/agents/{runtime,real,registry}.ts`, `lib/company/model.ts`, `lib/db.ts`, `components/MissionsBoard.tsx`.
- **DB:** additive `company_artifacts` + `company_events` (+3 indexes) + 2 additive `company_tasks` columns (`execution_kind`/`execution_ref_id`, idempotent migration). No existing table changed; `agent_tasks` untouched; workflow `runId` never overloaded with an agent-run id.
- **Decisions:** Executive Manager = evolved Conductor (not a new runtime); dispatch reuses existing agent runtime + Workflow Engine; capability gap NEVER creates an agent (F2); Human Approval reuses Phase E (no `company_approvals`); event ledger is append-only + NOT canonical state; bounded step, no autonomous loop.
- **Limitations:** exact-id capability matching only (no semantic); synchronous agent dispatch; workflow-task completion needs a manager-step/reconcile (no push); managerStep orders by creation order; report `managerSummary` opt-in (`?synthesize`); no task-level Phase-E approval wiring beyond surfacing `waiting_approval`. Department managers and G-Brain F3 NOT started.

### V2-F2 — Agent Factory ✅ complete
- **Purpose:** close the F1 `CAPABILITY_GAP` loop with CONTROLLED, HUMAN-GATED dynamic agent creation. When no existing agent (and no published workflow) can satisfy a task, the operator can propose an agent to fill the gap; an LLM proposes a spec, the SERVER validates it against a factory policy, and the agent is CREATED only when a human APPROVES (promotion). Reuses `createCustomAgent` under a policy wrapper — no forked creation, no autonomous loop.
- **Major changes:** pure model (`lib/company/factory/model.ts`) — `FactoryPolicy` + bounded override (allow-listed tools/models, `maxTools`/`maxInstructions`/`maxDepth` ceilings, `canSpawn=false`), `AgentSpecSchema`, `validateSpecAgainstPolicy` (fail-safe), safe projection. Service (`lib/company/factory/service.ts`) — `proposeAgentForGap` (verifies a real gap, injectable proposer, parse+validate, store PENDING; NO agent yet), `promoteProposal` (idempotent conditional resolve → `createCustomAgent` + assign EXACTLY the gap capabilities → F1 resolver now matches), `rejectProposal`, `retireTemporaryAgents` (disable + unassign on a terminal mission). `managerStep` retires temporary agents on mission completion. Missions Board gains a per-gap **Propose agent** button + a **Proposals** review strip (Approve/Reject).
- **Files:** `lib/company/factory/{model,service}.ts`; `app/api/company-tasks/[id]/propose-agent/route.ts`; `app/api/agent-proposals/[id]/{approve,reject}/route.ts`; `app/api/missions/[id]/proposals/route.ts`; modified `lib/company/manager/{model,service}.ts` (4 additive event types + retirement call), `lib/db.ts` (`company_agent_proposals` table + repo), `components/MissionsBoard.tsx`.
- **DB:** additive `company_agent_proposals` table + 2 indexes (`CREATE TABLE IF NOT EXISTS`). No existing table/column changed; `custom_agents`/`CustomAgent` schema untouched (all factory metadata lives on the proposal row).
- **Decisions:** proposal-first / create-on-approve (no agent exists until a human approves); operator-triggered proposal (NO auto-propose, no loop); reuse the Phase-E idempotent-resolve PATTERN (not the `flow_approvals` table — promotion has no run to resume); capabilities gate eligibility, not `enabled`, so a pending proposal assigns none; factory agents can't spawn (`canSpawn=false`, `maxDepth`); the SERVER grants EXACTLY the task's gap capabilities, never the LLM's list.
- **Limitations:** exact-id capability matching only (inherits F0.1); budget is stored + surfaced as a constraint but NOT hard-metered at runtime (agent_runs `cost_usd` is the honest next seam); synchronous agent dispatch (inherited); a proposed model must be on the allow-list (brittle-but-safe); no per-department factory policies. Department managers and semantic matching NOT started; no autonomous loop.

### V2-F3 — G-Brain Core ✅ complete
- **Purpose:** the canonical, durable, in-app company knowledge layer — Entities, Relationships, Knowledge, and Sources/provenance in SQLite. G-Brain REFERENCES the other canonical systems (never copies their mutable state) and ingests ONLY on explicit action. The **four graphs stay separate** (organization → registry · workflow → Flow engine · **knowledge → G-Brain Core** · execution → mission/task/run/event).
- **Major changes:** pure model (`lib/brain/core/model.ts`) — closed enums (entity/relationship/knowledge/source types), `canonicalKey`, bounded safe metadata, safe projections (knowledge list omits content), nullable-never-fabricated confidence, `BrainError`. Services (`entities`/`relationships`/`knowledge`/`sources`/`search`/`promote`/`projection`) — canonical-ref validation + one-entity-per-ref uniqueness; idempotent relationships with endpoint/self-link guards + `neighborhood` (F4 seam); explicit knowledge with provenance; sources (no credentials); deterministic bounded keyword search (no vector DB/Neo4j); explicit idempotent **artifact→brain promotion** (source+knowledge+provenance graph, artifact never modified, no auto-ingest); F4/F5 seam interfaces only. `BrainCorePanel` on `/brain` + a per-artifact **Promote to G-Brain** button on `/missions`.
- **Files:** `lib/brain/core/{model,entities,relationships,knowledge,sources,search,promote,projection}.ts`; `app/api/brain/{entities,entities/[id],entities/[id]/relationships,relationships,knowledge,knowledge/[id],sources,search}/route.ts`; `app/api/company-artifacts/[id]/promote-to-brain/route.ts`; `components/BrainCorePanel.tsx`; modified `lib/db.ts` (4 tables + repos), `app/brain/page.tsx` (mount), `components/MissionsBoard.tsx` (promote button), `tests/smoke-api.test.ts`, docs.
- **DB:** additive `brain_entities` (unique `canonical_key`) + `brain_relationships` (unique from+to+type) + `brain_knowledge` + `brain_sources` (+6 indexes; `CREATE TABLE IF NOT EXISTS`). No existing table/file changed; existing `/api/brain*` routes + the external gbrain store + the /brain viz all untouched.
- **Decisions:** new canonical in-app knowledge DB, distinct from the external gbrain markdown store AND the /brain visualization; canonical refs never copy state (unique entity per ref); explicit-only ingestion with NO agent write path (the external `saveToGBrain` tool is a separate system, unchanged); promotion is the one explicit artifact seam (idempotent, artifact untouched, no auto-ingest); keyword search only (no vector DB/Neo4j); Radial/Neural are read/interface SEAMS only; Hermes memory ≠ G-Brain; company events stay the operational ledger.
- **Limitations:** keyword search only (exact substring; the lexical `embedText` is an optional unused ranker); legacy markdown is an OPTIONAL import source (not auto-imported); no soft-delete UI beyond the `archived` status; no bulk import; F5 Neural, F6 analytics NOT started.

### V2-F4 — G-Brain Radial + Universal Inspector ✅ complete
- **Purpose:** turn the canonical F3 knowledge layer into an interactive structural view ("what is connected to this thing?") — a Radial graph centered on a selected entity + a Universal Inspector resolving any canonical object into a safe typed view with actions that route to existing systems. Radial is a PROJECTION (reads/resolves canonical state), never a second source of truth.
- **Major changes:** projection service (`lib/brain/projection/{model,radial}.ts`) — bounded `getRadialNeighborhood` (depth ≤ 2, ≤100 nodes/200 edges) combining PROJECTED canonical edges (Mission→Task, Task→Agent/Artifact/dep/capability, Artifact→Agent, Knowledge→Source) with PERSISTED F3 brain edges, each tagged `persisted`; strict `parseEntityRef`. Inspector service (`lib/brain/inspector/{model,service}.ts`) — one typed `InspectorView` per kind (agent/mission/task/artifact/knowledge/workflow/source/approval), safe fields only, CLOSED action set. UI: `BrainWorkspace` ([Radial][Neural] tabs, deep-link, search) + `BrainRadial` (deterministic SVG, pan/zoom/fit, no new deps) + `UniversalInspector`. `/brain?entity=kind:id` deep-link; "View in G-Brain" on `/missions`.
- **Files:** `lib/brain/projection/{model,radial}.ts`, `lib/brain/inspector/{model,service}.ts`; `app/api/brain/{radial,inspect}/route.ts`; `components/{BrainWorkspace,BrainRadial,UniversalInspector}.tsx`; modified `app/brain/page.tsx` (mount above the org constellation), `components/MissionsBoard.tsx` (deep-link), `tests/smoke-api.test.ts`, docs.
- **DB:** NONE — F4 is read-only projection + inspection over existing tables. No schema change.
- **Decisions:** Radial = structural projection · Neural = operational projection (F5, placeholder) · Inspector = canonical control/read surface; **projection node ≠ persisted BrainEntity, projected edge ≠ persisted BrainRelationship** (never written back); Inspector routes privileged/execution/destructive actions to the owning surface's existing U3/Phase-E confirm (only safe Promote/Archive are inline api actions); bounded, deterministic; the existing org/life viz + `BrainCorePanel` untouched.
- **Limitations:** re-root ("focus") on double-click rather than in-place node expansion; SVG radial (no d3-force physics); no minimap; no analytics (F6). No new deps.

### V2-F5 — G-Brain Neural ✅ complete
- **Purpose:** make the Neural tab the live/recent OPERATIONAL graph — "what is happening through these connections right now?" — projected read-only over the `company_events` ledger reconciled with current canonical state. Radial = structural · Neural = operational · Activity (U4) = chronological.
- **Major changes:** pure model (`lib/brain/neural/model.ts`) — closed node/edge/status enums, window parser (15m/1h/6h/24h), bounds, `projectionForEvent` (event→edge map) + canonical-status mappers. Service (`lib/brain/neural/service.ts`) — `getNeuralGraph` builds the bounded graph from windowed events and reconciles STATUS from current canonical state (task/mission/run/approval/presence), deduped + capped (≤250 events/150 nodes/300 edges). Additive `companyEvents` repo reads (`recent`/`since`/`forAgent`/`get`) — NO new table. Universal Inspector extended with safe `workflow_run` + `event` kinds. UI: `BrainNeural` (deterministic flow SVG, pan/zoom/fit, status colors, only-active pulse) replaces the F4 placeholder; window selector + ~5s polling (no-overlap, paused off-tab, stopped on unmount); shared selection across Radial↔Neural.
- **Files:** `lib/brain/neural/{model,service}.ts`; `app/api/brain/neural/route.ts`; `components/BrainNeural.tsx`; modified `lib/db.ts` (companyEvents reads), `lib/brain/inspector/{model,service}.ts` (+2 kinds), `components/BrainWorkspace.tsx` (Neural wiring + polling), `tests/smoke-api.test.ts`, docs.
- **DB:** NONE — F5 is read-only projection over existing tables (added `company_events` read methods only). No schema change.
- **Decisions:** Neural is a projection, never a runtime; `company_events` = ledger, current canonical state = status authority (no stale-event replay); bounded window + hard caps; polling (no WebSockets); no `company_events` into Radial; no `event → BrainKnowledge`; only genuinely-active nodes animate; shared F4 selection + one Universal Inspector.
- **Limitations:** approval nodes resolve via the task's workflow run (direct-agent approvals N/A); layered-by-kind layout (no force physics); factory chain shows only if events exist; polling (not push). No analytics (F6).

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
| Executive Manager / delegation (V2-F1) | LIVE | `lib/company/manager/*`, `/api/missions/:id/{plan,manager-step,report}` | Plan → decompose → dispatch to agent/workflow; bounded step |
| Agent Factory (V2-F2) | LIVE | `lib/company/factory/*`, `/api/company-tasks/:id/propose-agent`, `/api/agent-proposals/:id/{approve,reject}` | Human-gated dynamic agent creation to fill a capability gap; created only on approval |
| G-Brain Core (V2-F3) | LIVE | `lib/brain/core/*`, `/api/brain/{entities,relationships,knowledge,sources,search}`, `/api/company-artifacts/:id/promote-to-brain` | Canonical knowledge + relationships + provenance; explicit ingestion only; keyword search; references canonical objects, never copies state |
| External gbrain store + /brain viz | LIVE (separate) | `lib/brain.ts`, `lib/brain-graph.ts`, `knowledge-graph.ts`, `memory-core.ts` | External markdown second-brain + visualization; NOT the F3 canonical layer; untouched |
| G-Brain Radial + Universal Inspector (V2-F4) | LIVE | `lib/brain/projection/*`, `lib/brain/inspector/*`, `/api/brain/{radial,inspect}`, `components/{BrainWorkspace,BrainRadial,UniversalInspector}.tsx` | Interactive structural projection + typed inspector; projected vs persisted edges; actions route to existing systems; read-only, bounded |
| G-Brain Neural (V2-F5) | LIVE | `lib/brain/neural/*`, `/api/brain/neural`, `components/BrainNeural.tsx` | Live/recent operational graph over `company_events` + current canonical status; bounded window; ~5s polling; read-only, no new event store |
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
25. **The Agent Factory (F2) never creates an agent silently.** A factory agent is created ONLY by `promoteProposal` on an explicit human approval — never during planning, dispatch, or `managerStep`. Proposals are operator-triggered (no auto-propose, no loop). The SERVER owns policy (allow-listed tools/models, bounded count/instructions/depth, `canSpawn=false`) and grants EXACTLY the task's gap capabilities; a policy-violating spec fails safe and creates nothing. Factory agents are temporary and mission-bound (retired on a terminal mission). Promotion reuses the Phase-E idempotent-resolve pattern, not the `flow_approvals` table, and adds no second approval authority.
26. **Four graphs stay separate; G-Brain Core (F3) never duplicates canonical state.** Organization (registry), Workflow (Flow engine), Knowledge (G-Brain Core), and Execution (mission/task/run/event) are distinct DB models — never merged. A `brain_entities` row REFERENCES a canonical object via `canonical_key` (unique — one entity per ref) and stores only a safe name/summary, NEVER the object's mutable state (agent tools/model/status/permissions stay owned by the registry). **G-Brain ingestion is EXPLICIT only** — no LLM output, artifact, task result, chat, or company event is auto-written, and there is no agent write path to canonical G-Brain (the external `saveToGBrain` tool writes a SEPARATE markdown store). Artifact→brain promotion is the one explicit seam: idempotent, the artifact is never modified, and no other artifact is auto-ingested. Confidence is nullable and never fabricated. Company events remain the operational ledger; Hermes memory ≠ G-Brain. F4 Radial and F5 Neural are read/interface seams only.
27. **G-Brain Radial (F4) is a projection, never a source of truth.** The Radial view and Universal Inspector READ/RESOLVE canonical systems; they never persist. **A projection node ≠ a persisted BrainEntity and a projected edge ≠ a persisted BrainRelationship** — `Mission HAS_TASK Task` is projected live from Company Core and is NEVER written to `brain_relationships`; `Knowledge DERIVED_FROM Artifact` is a persisted F3 edge; each is tagged `persisted`. **Viewing a canonical object never auto-creates a BrainEntity.** The Radial is bounded (depth ≤ 2, ≤100 nodes/200 edges); `parseEntityRef` is strict (a URL parameter can never become an arbitrary query). The Universal Inspector is a CONTROL SURFACE, not authority: it exposes safe fields only (never prompts/model/tool-creds/`context_json`) and its privileged/execution/destructive actions DEEP-LINK to the owning surface's existing U3/Phase-E confirm — only the safe Promote/Archive actions call an existing API inline. F4 pipes NO `company_events` into the brain (that is F5).
28. **G-Brain Neural (F5) is a read-only operational projection, never a runtime or a second event store.** Neural READS the authoritative sources — `company_events` supplies the historical edge + timestamp, and CURRENT canonical state (`task.status`/`mission.status`/`flow_run.status`/`approval.status`/presence) is the sole authority for STATUS (never reconstructed from stale event replay). It does NOT orchestrate, dispatch, mutate canonical state, replace `company_events`/flow-runs/agent-runs/Phase E, or create a new event store. It is bounded (window default 60 min; ≤ 250 events / 150 nodes / 300 edges, `truncated`), safe (identifiers + labels + coarse status + safe summaries only — never prompts/tokens/`context_json`/startingInput/node outputs/tool args), and polls (~5s; **no WebSockets**). **No `company_events` is projected into Radial; Neural writes NOTHING to G-Brain knowledge (no `event → BrainKnowledge`).** Radial = structural · Neural = operational · Activity (U4) = chronological.
