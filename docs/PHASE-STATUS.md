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

## Planned phases (NOT built — do not implement unless instructed)

- **Phase D — Logic nodes:** Decision/router, Transform, Parallel/Join, conditional edges + `{{Node.field}}` mapping. Start: extend `resolveIncomingInputs` (`lib/flows/engine.ts`) + `WorkflowEdgeSchema.mapping/condition` (`lib/flows/schema.ts`).
- **Phase E — Human approval:** approval node, durable pause/resume, approval table + endpoints, destructive-action gates. (`NodeRunStatus` already reserves `waiting_approval`; `RunStatus` can reserve it too.)
- **Phase F — Memory:** explicit G-Brain read/write nodes, controlled knowledge promotion. (Still: no auto-save.)
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
| Decision / Transform / Parallel / Join | PLANNED Phase D | node types exist, not executable | Rejected pre-run |
| Human approval | PLANNED Phase E | — | `waiting_approval` reserved |
| Memory nodes | PLANNED Phase F | — | No auto-save today |
| Retries / error routes / cancel | PLANNED Phase G | — | Fail-fast only today |
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
16. Destructive/external actions will require **human approval** when Phase E lands; do not add unattended destructive side effects to executors before then.
17. Use the **repository layer**; pages/routes never touch SQLite directly.
18. Use the **executor registry** and the **ModelRouter**; do not scatter `switch (node.type)` or per-provider calls.
