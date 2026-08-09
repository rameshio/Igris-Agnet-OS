# CHANGE-LOG — engineering change records

> Detailed per-checkpoint engineering log (more granular than `CHANGELOG.md`).
> Every meaningful implementation checkpoint appends a record using the template
> below. Reconstructed for Phases A–C from the implemented code.

## Template

```
Change ID:      PHASE-X-CN
Phase:          X (checkpoint CN)
Summary:        one line
Reason:         why
Files added:    ...
Files modified: ...
Database:       tables/columns/indexes, or "no changes"
API:            routes/contract changes, or "no changes"
Behavior:       what user-visible behavior changed
Tests added:    ...
Tests run:      typecheck + which suites
Results:        pass/fail summary
Known limits:   ...
Rollback:       how to revert (note code vs schema rollback)
```

---

Change ID: **PHASE-A**
Summary: `/flows` workflow foundation (definition only, no execution).
Reason: Turn the legacy single-canvas into a typed, versioned, multi-workflow system.
Files added: `lib/flows/{schema,node-types,registry,validator}.ts`; `app/api/flows/{route,[id]/route,[id]/versions/route}.ts`; `app/flows/page.tsx`; `components/flows/{FlowWorkspace,FlowCanvas}.tsx`; tests `flows-schema/validator/repo/migration`.
Files modified: `lib/db.ts` (repos + import), `lib/nav.ts`.
Database: added `flow_workflows`, `flow_versions` (additive). Idempotent import of `agent_flows.main` → `wf-main`.
API: added `GET/POST /api/flows`, `GET/PATCH/DELETE /api/flows/:id`, `GET/POST /api/flows/:id/versions`.
Behavior: `/flows` route; create/save/publish workflows; nodes placed but not runnable.
Tests: 21 (schema/validator/repo/migration). Full suite green.
Known limits: nothing executes.
Rollback: additive — revert code; `flow_*` tables can remain (unused) or be dropped manually.

---

Change ID: **PHASE-B**
Summary: Unified model runtime (ModelRouter + providers + per-agent strategy).
Reason: One app-wide model architecture for agents/Conductor/flows.
Files added: `lib/models/{types,settings,connections,router}.ts`; tests `model-settings/connections/router`, `models-api`, `agent-model-routing`.
Files modified: `lib/db.ts` (repo `modelConnections`), `lib/models/catalog.ts` (Google/NVIDIA/Ollama/custom + flags), `lib/agents/chat.ts` (route via ModelRouter), `app/api/models/route.ts`, `components/{ModelsBoard,AgentBuilder}.tsx`, `components/flows/FlowCanvas.tsx` (badge).
Database: added `model_provider_connections` (metadata/status only, no secret).
API: `GET/POST/DELETE /api/models` extended (status, enable/disable, test, Hermes brain block).
Behavior: agent Fixed/Hermes/Auto strategy; connect/test/enable/disable providers; model badges on flow agent nodes.
Tests: 27 (settings/connections/router/api/agent-routing) incl. secret-leak + backward-compat. Full suite green.
Known limits: fixed providers text-only; Auto stub; no fallback.
Rollback: additive; revert code; `model_provider_connections` may remain.

---

Change ID: **PHASE-C**
Summary: Workflow execution engine + Run Inspector.
Reason: Make published workflow versions executable, persisted, inspectable.
Files added: `lib/flows/{run-types,errors,engine,coordinator}.ts`, `lib/flows/executors/{input,agent,output,index}.ts`; `app/api/flows/[id]/runs/route.ts`, `app/api/flows/runs/[runId]/route.ts`; tests `flow-runs-repo`, `flow-engine`, `flow-run-api`.
Files modified: `lib/db.ts` (`flowRuns`/`flowNodeRuns` repos), `lib/flows/registry.ts` (exec context/result + `validateNodeConfig`), `lib/flows/validator.ts` (`validateExecutable`), `components/flows/{FlowCanvas,FlowWorkspace}.tsx` (run UI), `tests/{smoke-api,orphans}.test.ts`.
Database: added `flow_runs`, `flow_node_runs` + 2 indexes (additive).
API: added `POST/GET /api/flows/:id/runs`, `GET /api/flows/runs/:runId`.
Behavior: Input→Agent→Output executes via engine + ModelRouter; run/node-run persisted; Run Inspector + canvas overlay + history; Save/Publish/Run distinction.
Tests: 19 (repo 4, engine 11 incl. no-auto-memory guard, api 4). Typecheck clean; full suite 1072 (flaky pair green on re-run).
Failure during dev: runs falsely `interrupted` — see INC-001; fixed by pinning the coordinator active set to `globalThis`.
Known limits: sequential; Input/Agent/Output only; no fallback/retry/cancel; Hermes usage null; stale runs → interrupted on read.
Rollback: additive; revert code; `flow_runs`/`flow_node_runs` may remain (unused).

---

Change ID: **CHORE-brain-canvas-removal**
Summary: Removed the legacy Agent Flow canvas from `/brain`.
Reason: `/flows` supersedes it; `/brain` must be knowledge-only.
Files modified: `app/brain/page.tsx` (removed `AgentFlowCanvas` render + import); `tests/orphans.test.ts` (allowlist `AgentFlowCanvas` as legacy).
Database: none. API: none (legacy `/api/agent-flows` still operational).
Behavior: `/brain` shows knowledge only; the canvas is gone from `/brain`.
Tests: typecheck clean; smoke green.
Rollback: re-add the render + import; remove the allowlist entry.

---

Change ID: **DOCS-ai-handoff**
Summary: AI-developer handoff package (this documentation set).
Reason: Enable safe continuation on another AI coding platform.
Files added: `docs/{AI-HANDOFF,PHASE-STATUS,DATA-MODEL,CODING-METHODOLOGY,TESTING-GUIDE,EXTENDING,SECURITY,LEGACY,DECISIONS,NEXT-AI-PROMPT,RELEASE-PROCESS,INCIDENTS,CHANGE-LOG}.md`, `CHANGELOG.md`.
Files modified: `AGENTS.md` (rewritten platform-independent), `docs/ARCHITECTURE.md` (Phase C status + module/ownership).
Database/API/Behavior: none (documentation only).
Tests: typecheck clean; full suite unchanged/green.
Rollback: revert docs.
