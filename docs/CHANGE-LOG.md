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

Change ID: **V2-CONSOLIDATION**
Phase: Architecture V2 · G-Brain consolidation (ONE brain + safe cleanup)
Summary: Collapse the duplicate G-Brain on `/brain` (old `BrainGraphView` [Radial][Neural] org constellation ABOVE the new F4/F5 [Radial][Neural] SVG workspace) into ONE brain — the original attractive `KnowledgeGraph`/`NeuralGraph` renderers now consume CANONICAL company data via an adapter; `/brain` is never blank; deep-links focus the same brain; and a safe mission archive/delete-test cleanup seam is added.
Reason: Manual verification found two Radial/Neural switchers stacked on `/brain` (confusing duplication) and the newer canonical Radial rendering BLANK on a bare `/brain`. The user preferred keeping the original visual and feeding it canonical data.
Files added: `lib/brain/company-brain-graph.ts` (structural + operational KGData adapters), `lib/brain/kg-ids.ts` (pure id encode/decode + `inspectTargetForKgId`), `lib/company/cleanup/service.ts` (`previewMissionCleanup`/`archiveMission`/`deleteTestMission`); `app/api/brain/company-graph/route.ts`; `app/api/missions/[id]/{cleanup-preview,archive,delete}/route.ts`; `tests/{company-brain-graph,mission-cleanup}.test.ts`.
Files modified: `components/BrainWorkspace.tsx` (rewritten as the controller driving the legacy renderers), `components/KnowledgeGraph.tsx` + `components/NeuralGraph.tsx` (additive `onSelectNode`/`focusNodeId`/`hideDirectory` props), `components/MissionsBoard.tsx` (Archive + Delete-test UI + archived filter/toggle), `app/brain/page.tsx` (removed the duplicate section), `lib/company/model.ts` (+`archived` mission status, direct-write archive), `lib/db.ts` (mission-scoped delete methods on company repos), `tests/{code-splitting,brain-page,smoke-api}.test.ts`, docs.
Files deleted: `components/BrainGraphView.tsx`, `components/BrainRadial.tsx`, `components/BrainNeural.tsx` (superseded — the retired duplicate + the plain F4/F5 SVG renderers).
Database: no schema change — added `archived` to the mission status enum (a status value), plus additive mission-scoped `deleteForMission`/`delete` repo methods. The graph is a read-only projection; nothing new is persisted.
API: added `GET /api/brain/company-graph?entity=&mode=structural|operational&window=` (read-only); `GET /api/missions/:id/cleanup-preview` (read-only); `POST /api/missions/:id/archive`; `POST /api/missions/:id/delete` (body `{confirm:true}` required). No global-wipe endpoint.
Behavior: `/brain` shows ONE `[Radial][Neural]` brain over canonical data — a bounded company-wide overview by default (never blank), `?entity=` focuses the same brain, clicks open the ONE Universal Inspector, F3 search focuses a result, the Neural tab polls the operational projection. `/missions` gains Archive (hides, keeps everything) + Delete-test (preview→confirm, scoped cascade, preserves shared state); archived missions hide behind a "show archived" toggle.
Tests added: `tests/company-brain-graph.test.ts` (7 — overview-not-blank, deep-link focus, focus-includes-outside-default, archived-excluded, id reverse-map, projection-not-persistence + leak canaries, operational from `company_events`); `tests/mission-cleanup.test.ts` (6 — preview owned vs preserved, archive keeps everything, delete requires confirm, cascade leaves no dangling rows, preserves shared agents/workflows/knowledge, retires-not-deletes temporary agents). Adjusted `code-splitting`/`brain-page`/`smoke-api`/`orphans` for the retired components + new routes.
Tests run: `tsc --noEmit` + full `vitest run`.
Results: 1610 passed (170 files); typecheck clean. Verified live on 4100 (structural overview 31 canonical nodes / not blank; invalid entity → 400; deep-link focused the mission + opened the Inspector; Neural tab renders operational without new errors; cleanup: preview → confirm-guard (400 without confirm) → cascade delete → 404, durable knowledge count preserved; UI Archive hid a mission 9→8 and surfaced "show archived"; only pre-existing console noise: `vantage-emblem.png` 404 + a `BrainViz` float hydration warning).
Known limits: operational Neural reuses the legacy neural-layer aesthetic (funnel by kind), not a bespoke operational layout; legacy Lens filters are org-shaped (cosmetic in canonical mode); cleanup is per-mission user-facing only (no bulk); durable knowledge is preserved, not garbage-collected.
Rollback: restore the three deleted components + `app/brain/page.tsx`'s old section; remove `lib/brain/{company-brain-graph,kg-ids}.ts`, `lib/company/cleanup/*`, the new routes, the MissionsBoard cleanup UI, and the `archived` status. Schema is unchanged (status value only), so no migration to reverse.

---

Change ID: **V2-F6**
Phase: Architecture V2 · F6 (Company Intelligence)
Summary: A derived, read-only analytical/decision-support layer over the company built in F0–F5 — work health, capability coverage, execution, approvals, and agent workload, plus deterministic explainable signals — bounded to a window (1h/24h/7d/30d, default 7d). Activity = chronological · Radial = structural · Neural = operational · Intelligence = analytical.
Reason: F4/F5 show raw/recent state; F6 answers "what is slowing the company down? where are gaps? which work waits too long?" as decision support — WITHOUT becoming a second source of truth, another orchestrator, or a new telemetry platform.
Files added: `lib/company/intelligence/model.ts` (pure snapshot + signal shapes, windows/thresholds, coverage classifier, duration stats, deterministic `deriveSignals`), `lib/company/intelligence/{work-health,capabilities,execution,approvals,agents}.ts` (analyzers), `lib/company/intelligence/service.ts` (`getCompanyIntelligence`); `app/api/company/intelligence/route.ts`; `components/CompanyIntelligence.tsx`; `app/intelligence/page.tsx`; `tests/company-intelligence.test.ts`.
Files modified: `lib/db.ts` (additive `companyTasks.all()` read), `lib/nav.ts` (`/intelligence` under Agents), `tests/{smoke-api,smoke,nav}.test.ts`, docs (ARCHITECTURE §6i, PHASE-STATUS F6 + matrix + invariant 29, CHANGELOG, SECURITY, AGENTS).
Database: no changes (read-only derived analysis; added one company-wide read method only — no table, no column, no new event/telemetry/analytics store).
API: added `GET /api/company/intelligence?window=1h|24h|7d|30d` (default 7d; invalid window → 400). Read-only; no mutation endpoint.
Behavior: new `/intelligence` dashboard (health summary + explainable signal cards + per-domain panels) with a window switcher, slow off-tab-paused poll, and evidence deep-links to Missions/G-Brain/Agents/Flows/Approvals. Navigation only — no action/mutation from Intelligence.
Tests added: `tests/company-intelligence.test.ts` (21 — pure helpers/determinism; work-health counts + stale detection + completed/cancelled-never-stale; capability gap/single/healthy + required-by + event/promotion correlation; execution completion/failure + execution mix + real-durations-only; approvals pending/oldest + tasks-waiting; agent active-assignments + overload + no-performance-score; workflow failure-cluster threshold; windowing accept/reject + out-of-window exclusion; separation no-mutation + no-brain-ingestion + determinism; privacy leak canaries). Plus `smoke-api` (company/intelligence 200), `smoke` (page renders), `nav` (group updated).
Tests run: `tsc --noEmit` + full `vitest run`.
Results: 1596 passed (168 files); typecheck clean. Verified live on 4100 (7d snapshot rich + correct, invalid window → 400, windowing applied, privacy clean, page renders + window switch re-fetches; the only console 404 is the pre-existing `vantage-emblem.png` asset, unrelated).
Known limits: exact-id capability matching (inherits F0.1); no cost/token/utilization/quality metrics (no telemetry backs them — honestly absent, rendered as insufficient_data); approval→task evidence resolves via the workflow run (direct-agent approvals show no task link); optional LLM narrative synthesis NOT built; thresholds are centralized constants (no settings UI yet).
Rollback: code-only (no schema). Remove `lib/company/intelligence/*`, `app/api/company/intelligence/*`, `app/intelligence/*`, `components/CompanyIntelligence.tsx`, the `companyTasks.all()` method, the nav entry, and the test/doc additions.

---

Change ID: **V2-F5**
Phase: Architecture V2 · F5 (G-Brain Neural)
Summary: The Neural tab becomes a read-only live/recent OPERATIONAL graph — missions → tasks → agents → workflow runs → approvals → artifacts — projected over the `company_events` ledger and reconciled with current canonical state, over a bounded time window with ~5s polling. Radial = structural · Neural = operational · Activity (U4) = chronological.
Reason: F4 shipped Neural as a placeholder. F5 answers "what is happening through these connections right now?" while strictly keeping Neural a projection (never a runtime, never a second event store) and current canonical state the authority for status.
Files added: `lib/brain/neural/model.ts` (pure enums/window/bounds/event→edge map/status mappers), `lib/brain/neural/service.ts` (`getNeuralGraph`); `app/api/brain/neural/route.ts`; `components/BrainNeural.tsx`; `tests/brain-neural.test.ts`.
Files modified: `lib/db.ts` (additive `companyEvents` reads `recent`/`since`/`forAgent`/`get` — NO new table), `lib/brain/inspector/{model,service}.ts` (+ safe `workflow_run` + `event` kinds), `components/BrainWorkspace.tsx` (Neural wiring: window selector + no-overlap polling paused off-tab + shared selection), `tests/{brain-inspector,smoke-api}.test.ts`, docs.
Database: NONE — F5 is read-only projection over existing tables (added `company_events` read methods only). No schema change.
API: `GET /api/brain/neural?entity=<ref|id>&window=15m|1h|6h|24h&limit=`. Read-only; no mutation endpoint.
Behavior: the `/brain` Neural tab renders the operational flow graph (deterministic left-to-right by kind; status colors; relative age; only genuinely-active nodes pulse), polls ~5s while active (no-overlap, stops off-tab/on-unmount, "as of {generatedAt}"), honors a window selector, and shares selection + the Universal Inspector (now covering `workflow_run` + `event`) with Radial. Company-now view when no root; honest empty state.
Tests added: 10 neural (mission→task/task→agent/artifact/workflow_run/approval edges, factory events, **current-status-overrides-stale-event**, bounds/truncation, focus + company-now + malformed-reject, dedup, **no-mutation**, startingInput/context_json privacy) + 2 inspector (workflow_run/event safe).
Tests run: `tsc --noEmit` (clean); vitest brain + smoke suites; full suite.
Results: pass (typecheck clean; 12 new tests green; full suite 1573).
Known limits: approval nodes resolve via the task's workflow run; layered-by-kind layout (no force physics); factory chain only if events exist; polling (no push/WebSockets). No analytics (F6).
Rollback: code rollback removes the neural service/route/UI + the two inspector kinds; the additive `company_events` read methods are inert if unused. Nothing persisted to reverse (read-only).

---

Change ID: **V2-F4**
Phase: Architecture V2 · F4 (G-Brain Radial + Universal Inspector)
Summary: An interactive structural view over the canonical F3 knowledge layer — a Radial graph centered on a selected entity + a Universal Inspector resolving any canonical object into a safe typed view. Radial is a PROJECTION (reads/resolves canonical state); it never persists, and projected edges are never written back to G-Brain.
Reason: F3 gave the company canonical knowledge but only a list/search UI. F4 answers "what is connected to this thing?" and makes G-Brain an operating view, while strictly preserving projection ≠ persistence and Inspector-as-control-surface-not-authority.
Files added: `lib/brain/projection/{model,radial}.ts` (bounded projection + strict deep-link parser), `lib/brain/inspector/{model,service}.ts` (typed per-kind views + closed actions); `app/api/brain/{radial,inspect}/route.ts`; `components/{BrainWorkspace,BrainRadial,UniversalInspector}.tsx`; `tests/brain-projection.test.ts`, `tests/brain-inspector.test.ts`.
Files modified: `app/brain/page.tsx` (mount `BrainWorkspace` above the unchanged org constellation), `components/MissionsBoard.tsx` ("View in G-Brain" deep-link), `tests/smoke-api.test.ts`, docs.
Database: NONE — F4 is read-only projection + inspection over existing tables. No schema change.
API: `GET /api/brain/radial?entity=<ref|id>&depth=&limit=`, `GET /api/brain/inspect?kind=&id=`. No mutation endpoint; Inspector mutations reuse existing APIs.
Behavior: `/brain` gains a `[Radial][Neural]` workspace above the org/life constellation. Radial (active) centers on a searched/deep-linked entity, click-to-inspect via the Universal Inspector, double-click to focus (re-root); Neural is an honest F5 placeholder (no `company_events` piped in). `/missions` gains a "View in G-Brain" link. Deep-link `/brain?entity=kind:id`; selection preserved across the tab switch. Persisted edges draw solid, projected dashed.
Tests added: 11 projection (projected mission→task/task→artifact/agent/dep/capability edges, persisted knowledge edge, dedup, node/depth caps, **no auto-persistence**, safe fields, strict `parseEntityRef`) + 9 inspector (each kind resolves; unknown rejected; no secrets/prompts/model; closed action ids; privileged actions are navigate, only safe promote/archive are inline api).
Tests run: `tsc --noEmit` (clean); vitest brain + smoke-api suites; full suite.
Results: pass (typecheck clean; 20 F4 tests green; full suite 1560).
Known limits: re-root ("focus") on double-click rather than in-place expansion; SVG radial (no d3-force physics/minimap); Neural is a placeholder (F5); no analytics (F6). No new deps; no DB change.
Rollback: code rollback removes the projection/inspector services + routes + UI; nothing persisted to reverse (F4 is read-only).

---

Change ID: **V2-F3**
Phase: Architecture V2 · F3 (G-Brain Core)
Summary: The canonical, durable, in-app company knowledge layer — Entities, Relationships, Knowledge, and Sources/provenance in SQLite. G-Brain REFERENCES the other canonical systems (never copies their mutable state) and ingests ONLY on explicit action. The four graphs (organization/workflow/knowledge/execution) stay separate.
Reason: Through F2 the company can plan/delegate/create agents but has no canonical knowledge layer with provenance. What existed under "G-Brain" was entirely external (gbrain CLI markdown store) or visualization-only (`/brain` force/vector graphs). F3 adds the missing durable in-app knowledge core without disturbing either.
Files added: `lib/brain/core/{model,entities,relationships,knowledge,sources,search,promote,projection}.ts`; `app/api/brain/{entities/route,entities/[id]/route,entities/[id]/relationships/route,relationships/route,knowledge/route,knowledge/[id]/route,sources/route,search/route}.ts`; `app/api/company-artifacts/[id]/promote-to-brain/route.ts`; `components/BrainCorePanel.tsx`; `tests/brain-core-model.test.ts`, `tests/brain-core-service.test.ts`, `tests/brain-promote.test.ts`.
Files modified: `lib/db.ts` (4 additive tables + repos), `app/brain/page.tsx` (mount `BrainCorePanel` below the existing viz), `components/MissionsBoard.tsx` (per-artifact Promote-to-G-Brain button), `tests/smoke-api.test.ts` (4 new GET routes), docs.
Database: additive `brain_entities` (unique `canonical_key`) + `brain_relationships` (unique from+to+type) + `brain_knowledge` + `brain_sources` + 6 indexes (`CREATE TABLE IF NOT EXISTS`). No existing table/file changed; existing `/api/brain*` routes, the external gbrain store, and the /brain viz are all untouched.
API: `GET/POST /api/brain/entities`, `GET /api/brain/entities/:id`, `GET /api/brain/entities/:id/relationships`, `POST /api/brain/relationships`, `GET/POST /api/brain/knowledge`, `GET/PATCH /api/brain/knowledge/:id`, `GET/POST /api/brain/sources`, `GET /api/brain/search`, `POST /api/company-artifacts/:id/promote-to-brain`. No generic mutate-anything endpoint.
Behavior: `/brain` gains a Company-Knowledge panel (knowledge list + search + explicit create + entity list) below the unchanged visualization; `/missions` gains a per-artifact "Promote to G-Brain" button. Durable knowledge is created only by explicit action.
Tests added: 16 pure-model + 16 service (entity canonical-ref validation/uniqueness, relationship endpoints/self-link/idempotency/safe metadata, knowledge provenance/nullable-confidence/safe projection, source resolution, bounded keyword search, separation from other canonical systems) + 5 promotion (source+knowledge+provenance, idempotent, artifact unchanged, no auto-ingest, safe projection).
Tests run: `tsc --noEmit` (clean); vitest brain + smoke-api suites; full suite.
Results: pass (typecheck clean; 37 brain tests green; full suite 1539).
Known limits: keyword search only (no vector DB/Neo4j; the lexical `embedText` is an optional unused ranker); legacy markdown is an OPTIONAL import source (not auto-imported); knowledge lifecycle is `active`/`archived` (no hard-delete UI); no bulk import. F4 Radial/Universal Inspector, F5 Neural/live event flow, and F6 analytics NOT started.
Rollback: code rollback removes the brain-core services/routes/UI; the additive `brain_*` tables are inert if unused. No data migration to reverse; no existing content touched.

---

Change ID: **V2-F2**
Phase: Architecture V2 · F2 (Agent Factory)
Summary: Controlled, human-gated dynamic agent creation that fills the F1 `CAPABILITY_GAP`. When no existing agent or published workflow can satisfy a task, the operator proposes an agent; an LLM proposes a spec, the server validates it against a factory policy, and the agent is CREATED only on human approval (promotion). Reuses `createCustomAgent` under a policy wrapper — no forked creation, no autonomous loop.
Reason: F1 deliberately stops at a structured capability gap ("F1 never creates an agent — that is F2"). F2 closes that loop while keeping creation policy-gated, human-approved, mission-bound/temporary, and non-spawning.
Files added: `lib/company/factory/model.ts` (pure — `FactoryPolicy` + bounded override, `AgentSpecSchema`, `validateSpecAgainstPolicy`, safe projection), `lib/company/factory/service.ts` (`proposeAgentForGap` / `promoteProposal` / `rejectProposal` / `retireTemporaryAgents`, injectable proposer); `app/api/company-tasks/[id]/propose-agent/route.ts`; `app/api/agent-proposals/[id]/{approve,reject}/route.ts`; `app/api/missions/[id]/proposals/route.ts`; `tests/company-factory.test.ts`, `tests/company-factory-service.test.ts`.
Files modified: `lib/company/manager/model.ts` (+4 additive event types AGENT_PROPOSED/PROMOTED/REJECTED/RETIRED), `lib/company/manager/service.ts` (retire temporary agents on mission completion), `lib/db.ts` (`company_agent_proposals` table + `companyAgentProposals` repo with idempotent `resolve`), `components/MissionsBoard.tsx` (Propose agent + Proposals review strip), `tests/smoke-api.test.ts` (proposals route), docs.
Database: additive `company_agent_proposals` table + 2 indexes (`CREATE TABLE IF NOT EXISTS`). No existing table/column changed; `custom_agents`/`CustomAgent` schema untouched (factory metadata lives on the proposal row).
API: `POST /api/company-tasks/:id/propose-agent`, `POST /api/agent-proposals/:id/approve`, `POST /api/agent-proposals/:id/reject`, `GET /api/missions/:id/proposals`. No generic execute-anything endpoint.
Behavior: `/missions` shows a **Propose agent** button when a task has no eligible agent, and a **Proposals** strip to Approve/Reject. Approval creates an enabled custom agent assigned exactly the gap capabilities → the F1 resolver matches → the next Manager Step dispatches the task. A completed mission retires its temporary factory agents.
Tests added: 14 pure-model + 8 service (propose→pending with no agent; refuses a non-gap; policy violation ⇒ 400 fail-safe; promote creates + assigns + resolver matches + dispatch; idempotent promote/reject; retire disables + unassigns; full end-to-end gap→propose→approve→managerStep→complete→retire).
Tests run: `tsc --noEmit` (clean); vitest factory + smoke-api suites; full suite.
Results: pass (typecheck clean; factory 22/22; smoke net green).
Known limits: exact-id capability matching only (inherits F0.1); operator-triggered proposal only (no auto-propose); budget stored + surfaced but not hard-metered at runtime (agent_runs `cost_usd` is the seam); proposed model must be allow-listed; no per-department policies. No department managers, no semantic matching, no G-Brain F3, no autonomous loop.
Rollback: code rollback removes the routes/service/model/UI; the additive `company_agent_proposals` table is inert if unused (safe to leave). No data migration to reverse.

---

Change ID: **V2-F1**
Phase: Architecture V2 · F1 (Executive Manager / Delegation Engine)
Summary: An Executive Manager (the evolved Conductor) plans a Mission, decomposes it into Company Tasks, capability-matches, and delegates to an existing agent OR an existing published workflow — with Artifacts, an append-only event ledger, and a report. Bounded, durable, deterministic, human-triggered.
Reason: F0.1 (capabilities) + F0.2 (missions/tasks) gave the data + registry; F1 is the first phase where IGRIS actually operates — planning and delegating real work — WITHOUT a parallel engine, an Agent Factory, or an autonomous loop.
Files added: `lib/company/manager/{model,planning,delegation,service,artifacts,events}.ts`; APIs `app/api/missions/[id]/{plan,manager-step,report,events}/route.ts`, `app/api/company-tasks/[id]/dispatch/route.ts`, `app/api/company-artifacts/[id]/route.ts`; tests `company-manager.test.ts`, `company-manager-delegation.test.ts`, `company-manager-service.test.ts`.
Files modified: `lib/agents/runtime.ts` (+`role?: 'executive_manager'` on RuntimeAgent), `lib/agents/real.ts` (Conductor tagged executive_manager), `lib/agents/registry.ts` (+`getExecutiveManager`), `lib/company/model.ts` (CompanyTask +`executionKind`/`executionRefId`), `lib/db.ts` (company_artifacts + company_events DDL/repos, company_tasks exec columns + `migrateCompanyTasksTable`), `components/MissionsBoard.tsx` (+manager controls/report/events), `tests/smoke-api.test.ts`; docs.
Database: **additive only** — `company_artifacts`, `company_events` (+3 indexes), and 2 additive columns on `company_tasks` (`execution_kind`, `execution_ref_id`) via an idempotent `ALTER TABLE ADD COLUMN` migration + DDL for fresh DBs. No existing table/column changed; `agent_tasks` untouched; the workflow `runId` is never overloaded with an agent-run id.
API: new `POST /api/missions/:id/plan` (decompose), `POST /api/missions/:id/manager-step` (one bounded tick), `POST /api/company-tasks/:id/dispatch`, `GET /api/missions/:id/report[?synthesize]`, `GET /api/missions/:id/events`, `GET /api/company-artifacts/:id`. No generic/arbitrary manager endpoint; no new mutation to Flows/Approvals.
Behavior: plan → validated schema, server-generated task ids, idempotent-by-title apply, mission draft→active, MISSION_PLANNED. Dispatch → deterministic target (published workflow > eligible agent > capability_gap); agent path runs one `agent_runs` run synchronously → completed/failed + one artifact; workflow path starts one flow run on the published version and is reconciled to completion (waiting_approval → Phase E). managerStep is bounded (≤3), reconciles running workflow tasks, promotes satisfied dependencies, and completes the mission only when every non-cancelled task is completed (a failure blocks it). Capability gap never creates an agent (F2). Events append after state persists (best-effort). Report is deterministic (optional grounded LLM summary, non-mutating).
Tests added: `company-manager.test.ts` (policy/completion/schemas/planning: valid+invalid plans, server ids, idempotent apply, dependencies); `company-manager-delegation.test.ts` (agent dispatch = exactly one run + one artifact + lifecycle + idempotent retry; capability gap creates no agent; dependency waiting; workflow dispatch via existing engine + reconcile; draft-only workflow never run; no-leak); `company-manager-service.test.ts` (bounded step, deterministic completion, failure blocks completion, report accuracy, execution-ref durability across DB re-open). Extended smoke-api.
Tests run: targeted F1 files, then `tsc --noEmit` (clean), then full Vitest suite.
Results: **1475 passed / 159 files; tsc clean** (was 1450/156). Live smoke: plan creates tasks (no execution), dispatch to a capable agent runs once + records an artifact, capability gap returns a structured result with no agent created, workflow dispatch starts one published-version run, manager-step is bounded, existing surfaces unaffected.
Known limits: capability matching is exact-id only (no semantic); agent dispatch is synchronous (long agent work blocks the request — a future queue is out of scope); workflow-task completion requires a `manager-step`/`reconcile` (no push); `managerStep` orders by task-creation order; report `managerSummary` is opt-in (`?synthesize`) and best-effort; no per-task-level Phase-E approval wiring beyond surfacing `waiting_approval` (deferred to a later F1 follow-on). No F2 Agent Factory, no department managers, no G-Brain ingestion.
Rollback: code-only apart from additive tables/columns (safe to leave). Revert the added manager files + routes + the small edits to runtime/real/registry/model/db/MissionsBoard; the additive `company_artifacts`/`company_events` tables and the two `company_tasks` columns are harmless if left in place.

---

Change ID: **V2-F0.2**
Phase: Architecture V2 · F0.2 (Mission + Company Task canonical model)
Summary: First-class Mission + Company Task data model, services, APIs, and minimal Missions UI — the canonical company-work layer, DISTINCT from the existing `agent_tasks` kanban. F0.1 capability-assisted manual assignment, optional task dependencies, parent/subtask hierarchy.
Reason: The V2 architecture needs a canonical work store (Mission = company objective, Company Task = work unit) before the F1 Manager can plan/delegate. F0.2 builds the DATA + ORGANIZING layer only — no planning, no decomposition, no automatic assignment, no delegation, no execution.
Files added: `lib/company/model.ts` (pure model — types, Zod schemas, status enums + transition guards, graph helpers for cycle detection, mission summary, prerequisite check), `lib/company/service.ts` (canonical service — create/read/update boundary composing repos + pure model + F0.1 capability resolver; CompanyError with HTTP status mapping), `app/api/missions/route.ts` (GET list, POST create), `app/api/missions/[id]/route.ts` (GET one + summary, PATCH update), `app/api/missions/[id]/tasks/route.ts` (GET list, POST create under mission), `app/api/company-tasks/[id]/route.ts` (GET one + deps + satisfied, PATCH update), `app/api/company-tasks/[id]/assign/route.ts` (POST manual assignment), `app/api/company-tasks/[id]/dependencies/route.ts` (GET/POST/DELETE), `app/api/company-tasks/[id]/eligible-agents/route.ts` (GET F0.1 resolver), `components/MissionsBoard.tsx` (admin UI), `app/missions/page.tsx` (page); tests `tests/company-model.test.ts`, `tests/company-service.test.ts`.
Files modified: `lib/db.ts` (additive DDL `company_missions` + `company_tasks` + `company_task_dependencies` + 5 indexes; three repos `companyMissions`/`companyTasks`/`companyTaskDeps`; new types `Mission`/`CompanyTask`/`CompanyTaskDependency` imported from model), `lib/nav.ts` (+`/missions` in NAV_AGENTS), `tests/smoke-api.test.ts` (+2 GET routes `missions`/`company-tasks/[id]/dependencies`; +5 IGNORE entries for parameterized F0.2 routes), `tests/nav.test.ts` (count updated), `docs/ARCHITECTURE.md` (§6c), `docs/CHANGE-LOG.md` (this record), `docs/PHASE-STATUS.md` (feature matrix + phase entry), `CHANGELOG.md` (user-facing entry), `AGENTS.md`/`CLAUDE.md` (status update).
Database: **additive + idempotent.** `company_missions (id PK, title, objective, status, priority, created_by, created_at, updated_at, started_at, completed_at)` + `idx_company_missions_status`; `company_tasks (id PK, mission_id, parent_task_id, title, objective, status, assigned_agent_id, workflow_id, run_id, priority, required_capabilities JSON, created_at, updated_at, started_at, completed_at)` + `idx_company_tasks_{mission,status,agent,parent}`; `company_task_dependencies (task_id, depends_on_task_id, created_at, PK(task_id,depends_on_task_id))` + `idx_company_task_deps_dependson`. Cross-subsystem references (agent/workflow/run/parent/mission) validated in the service layer, not by FK, matching the repo canonical-id strategy. No existing table/column changed; re-running DDL is a no-op.
API: new `GET/POST /api/missions`; `GET/PATCH /api/missions/:id`; `GET/POST /api/missions/:id/tasks`; `GET/PATCH /api/company-tasks/:id`; `POST /api/company-tasks/:id/assign`; `GET/POST/DELETE /api/company-tasks/:id/dependencies`; read-only `GET /api/company-tasks/:id/eligible-agents`. All Zod-validated. No mutation to any existing endpoint; no new execution path.
Behavior: Missions are draft → active → completed/failed/cancelled (guarded transitions). Company Tasks are queued → assigned → running → completed/failed/cancelled (guarded; `waiting_dependency`/`waiting_approval` statuses exist as seams for F1 but F0.2 never auto-transitions to them). Parent/subtask hierarchy (same-mission, cycle-rejected via DFS). Task dependencies (same-mission, acyclic, idempotent; `prerequisitesSatisfied` is read-only — never auto-starts). Manual assignment is HONEST: if a task declares required capabilities, the agent MUST satisfy ALL of them (F0.1 resolver `mode: all`) — otherwise 409 Conflict. `workflowId` is a validated reference seam (never runs anything); `runId` is F1's execution reference (never created here). Eligible-agent resolution (read-only, safe metadata only). Mission summary (task rollup by status — never auto-completes a mission). Company operations NEVER touch `agent_tasks`. Outputs carry no prompts/secrets/tool config.
Tests added: `company-model.test.ts` (12 tests: status enums, transition validators, terminals, graph reachability + cycle guard, mission summary, prerequisite check, Zod schemas incl. capability normalization + malformed rejection), `company-service.test.ts` (10 tests: create/get/list + guarded transitions + timestamps, parent rules + reparent cycle, task status transitions, workflow reference validation, dependency add/idempotent/self/cross-mission/cycle/prerequisite, eligible resolution + compat-checked assignment, agent_tasks separation, output security, schema idempotency + data preservation). Extended `smoke-api.test.ts` (+2 routes, +5 ignores).
Tests run: targeted F0.2 files, then `tsc --noEmit` (clean), then full Vitest suite.
Results: **1450 passed / 156 files; tsc clean.**
Known limits: F0.2 never auto-transitions task status (no orchestration); `waiting_dependency`/`waiting_approval` are seams only (no automatic dependency resolution, no approval integration — that is F1/Phase-E follow-on); no pagination on mission/task lists (sufficient for F0.2 admin surface); no soft-delete/archive; `workflowId`/`runId` validated but execution never triggered; capability catalog vocabulary left empty until confirmed by roles; built-in agents still have no seeded capabilities. F1 Manager, F2 Agent Factory, and G-Brain F3 are NOT started.
Rollback: code-only + additive schema. Revert the added files + the db.ts/nav.ts/smoke edits; the new tables are inert if unused (no code path reads them after revert). No existing data migrated.

---

Change ID: **V2-F0.1**
Phase: Architecture V2 · F0.1 (Company Registry — Capability layer)
Summary: A first-class, deterministic Capability layer over the existing agent registry so future Manager logic can resolve agents by capability. Registry/data/resolution only — no execution.
Reason: The V2 audit (GO WITH CHANGES) named capability resolution the keystone: the Manager must "find workers by capability, not load every agent into context". Nothing else V2 (Missions/Tasks, delegation, Factory) can be built without it.
Files added: `lib/agents/capabilities.ts` (pure model + id rules + Zod schemas + deterministic resolver), `app/api/capabilities/route.ts`, `app/api/agents/[id]/capabilities/route.ts`, `app/api/agents/resolve/route.ts`; tests `capabilities.test.ts`, `capabilities-registry.test.ts`.
Files modified: `lib/db.ts` (additive DDL `capabilities` + `agent_capabilities` + index; two repos; wired into the returned db), `lib/agents/registry.ts` (Company Registry: getAgentById / getCapabilitiesForAgent / getAgentsForCapability / resolveAgentsForCapabilities), `tests/smoke-api.test.ts` (+2 GET routes, +1 ignore); docs (`CHANGELOG.md`, `docs/ARCHITECTURE.md` §6b + §12).
Database: **additive + idempotent.** `capabilities (id, name, description, domain, created_at)` and `agent_capabilities (agent_id, capability_id, proficiency, source, created_at, PK(agent_id,capability_id))` + `idx_agent_capabilities_capability`. `agent_id` is the canonical RuntimeAgent id (built-in OR custom-*) — NOT an FK. No existing table/column changed; re-running the DDL is a no-op (`CREATE TABLE IF NOT EXISTS`), existing data untouched.
API: new `GET/POST /api/capabilities`, `GET/POST/DELETE /api/agents/:id/capabilities`, read-only `GET /api/agents/resolve?capabilities=…&mode=…`. All Zod-validated. No mutation to any existing endpoint; no new execution path.
Behavior: capabilities are defined explicitly (`domain.action`, lowercase, validated); assigned to any agent by canonical id (idempotent); the resolver returns eligible agents deterministically (all/any, coverage → explicit-over-derived → proficiency → tie-break) with SAFE metadata only. Distinctions documented: Capability (can) ≠ Skill/Tool/Model (support) ≠ Permission (may) ≠ Approval (authorization). No LLM matching. No resolution result starts, assigns, delegates, runs, or creates anything.
Tests added: `capabilities.test.ts` (id validate/normalize incl. malformed-rejected, Zod schemas, resolver all/any/no-match/empty/normalize/coverage/explicit-vs-derived/proficiency-neutral-baseline/tie-break/safe-output-keys), `capabilities-registry.test.ts` (upsert + assign idempotency, built-in AND custom agent handling, forAgent/forCapability, unknown-agent-ignored, resolver over real repos, no prompt/tool/secret leak, DDL idempotency + existing-data-unaffected). Extended smoke-api.
Tests run: targeted F0.1 files, then `tsc --noEmit` (clean), then full Vitest suite.
Results: **1425 passed / 154 files; tsc clean** (was 1398/152). Live smoke: create `research.web` (malformed id → 400); assign to an agent (proficiency 80); resolve `research.web` → the agent (score 1); assign `research.market`, resolve both `mode=all` → agent (score 2); resolve unassigned `legal.canada` → `[]` (no guess); `/`, `/agents`, `/org`, `/flows` all 200; test assignments cleaned up afterward.
Known limits: built-in agents ship with NO seeded capabilities (assignment is explicit/manual to avoid guessing); no derived-capability inference implemented (the `source:'derived'` seam exists for later, deterministic use); `proficiency` is config metadata, not measured; `reportsTo`/lifecycle columns deferred (`parentId` already carries reporting). Capability catalog vocabulary can be seeded later when roles are confirmed.
Rollback: code-only + additive schema. Revert the added files + the db.ts/registry.ts edits; the new tables are inert if unused (no code path reads them after revert). No existing data migrated.

---

Change ID: **UX-U6**
Phase: UX Foundation U6 (Commander Home) — completes the UX Foundation
Summary: Home becomes the AI-native operating surface — briefing + Commander entry + a summary of real operational state — composed from existing services, no new truth.
Reason: Home was a business-analytics dashboard. U6 redefines it as the operating surface answering "what needs me / what is running / what just happened / what do I want IGRIS to do", with the Commander prominent.
Files added: `lib/home/model.ts` (pure: greeting, summary line, first-run, cheap Hermes status, nav targets), `lib/home/service.ts` (`buildHomeSnapshot` — composes U4/U5 + repos), `app/api/home/route.ts`, `components/HomeDashboard.tsx` (client operating surface); tests `home-model.test.ts`, `home-service.test.ts`.
Files modified: `app/page.tsx` (rewritten to the server shell that renders HomeDashboard; old analytics dashboard removed from Home only), `components/Commander.tsx` (additive `detail.prefill` on the `alex:palette` open event — no redesign), `tests/smoke-api.test.ts` (+`/api/home`), `tests/orphans.test.ts` (allowlist `HomeSocialGraph`, now Home-only and unmounted — kept, not deleted); docs (`CHANGELOG.md`, `docs/ARCHITECTURE.md` §9f).
Database: **no changes.** Read-only projection composed over `flow_runs` / `flow_approvals` / `flow_node_runs` + the `meta` KV + the runtime agent registry.
API: one new read-only `GET /api/home` (the whole `HomeSnapshot`). No mutation path; the Commander still uses the existing endpoints.
Behavior: Home renders greeting + briefing summary + a Commander entry (opens the existing Commander, optionally prefilled) + Needs You (pending approvals + failures within 24h) + Running (only genuinely-running flow runs; waiting_approval counted active but shown under Needs You) + Recent (bounded U4 feed) + a System strip (Hermes from cached meta — never probes, never green when unknown; Agents / Active runs / Approvals / Failures with documented meaning). Empty → honest "all caught up"; genuinely-empty workspace → compact first mission (links only). Single 8s no-overlap poll. Greeting is hydration-safe (server value first, local-time re-derive in a mount effect).
Tests added: `home-model.test.ts` (greeting boundaries, summary line incl. empty, first-run, Hermes classification incl. never-green-when-unknown, nav targets), `home-service.test.ts` (real repos: pending approval composition, running-vs-waiting, active count, recent-failure window, bounded recent, empty/first-run, no-leak canary). Extended smoke-api + orphans.
Tests run: targeted U6 files, then `tsc --noEmit` (clean), then full Vitest suite.
Results: **1398 passed / 152 files; tsc clean** (was 1376/150). Live smoke: Home renders the operating surface with real data (3 pending approvals, running empty, real U4 recent feed, honest System strip); `GET /api/home` 200 JSON with no context/secret leak; the command entry opens the existing Commander prefilled; no hydration warnings.
Known limits: recent-failure window is a fixed 24h; the System "Failures" count is that window (not live-verified failures); Hermes status reflects the LAST recorded Settings check (unknown until Settings is opened once) — deliberately, to avoid probing the CLI on every poll; `HomeSocialGraph` is retained but no longer mounted (allowlisted). No first-run onboarding wizard (links only), by design.
Rollback: code-only (no schema). Revert the added files + `app/page.tsx` + the Commander prefill hook; the old Home dashboard is in git history if a business-analytics Home is ever wanted back.

---

Change ID: **UX-U5**
Phase: UX Foundation U5 (Approval Decision Cards + Agent Presence)
Summary: `/approvals` becomes a trustworthy decision surface and `/agents` shows real operational presence — two read-only projections over existing state, no new table.
Reason: Approvals read as bare list rows (unclear what/why/effects/risk); agents looked static. Make approvals a decision surface and agents visibly operational — both DERIVED from authoritative data, never fabricated.
Files added: `lib/flows/approval-view.ts` (pure view + risk heuristic + downstream classifier), `lib/flows/approval-cards.ts` (service), `app/api/flow-approvals/cards/route.ts`; `lib/agents/presence.ts` (pure reducer), `lib/agents/presence-service.ts` (service), `lib/agents/presence-store.ts` (client store), `app/api/agents/presence/route.ts`, `components/AgentPresence.tsx`; tests `approval-view.test.ts`, `approval-cards-service.test.ts`, `agent-presence.test.ts`, `agent-presence-service.test.ts`.
Files modified: `components/ApprovalsInbox.tsx` (rewritten as decision cards + envelope publishing), `lib/context-envelope.ts` (`applyApproval` gains `workflowId`, new `clearApproval`/`clearApprovalContext`), `components/AgentChat.tsx` (publish `agentId` on open, outside the state updater), `app/agents/page.tsx` (compute presence, mount poller, presence tag per card), `tests/context-envelope.test.ts` (+agent/approval publishing), `tests/smoke-api.test.ts` (+2 GET routes); docs (`CHANGELOG.md`, `docs/ARCHITECTURE.md` §9e).
Database: **no changes.** Both surfaces are read-only projections over `flow_runs`/`flow_node_runs`/`flow_approvals` + the immutable version graph.
API: new read-only `GET /api/flow-approvals/cards` (`{ pending, resolved }`) and `GET /api/agents/presence` (`{ presence }`). Legacy `GET /api/flow-approvals` list untouched. Approval resolution reuses the existing `POST …/approve|reject` (no new mutation path).
Behavior: pending approvals render as decision cards (what/why/if-approved/if-rejected/risk); resolved history is inspectable with actions disabled. Risk is conservative and never under-claimed (request-type floor × downstream graph classification; unknown → medium). Agents show `idle|working|waiting_approval|failed` derived from real run/node/approval state with deterministic precedence + a 6h recency window; identity resolved from the version graph, never guessed. Selecting an approval card publishes `approvalId`/`runId`/`workflowId` so the existing Commander "approve this" (U3) works unchanged. `context_json` and secrets are never exposed in the card projection.
Tests added: `approval-view.test.ts` (safe view, route labels/effects, resolved-disables-actions, risk floors × downstream, no context/secret fields, downstream classifier), `approval-cards-service.test.ts` (real repos: pending/resolved, workflow name + external risk from graph, no context leak), `agent-presence.test.ts` (states, precedence, ancient-failure/stale-running recency, clock-skew, idle-not-guessed), `agent-presence-service.test.ts` (running→working, pending-approval→waiting, failed→failed, idle omitted, non-agent failure not attributed). Extended context-envelope + smoke-api.
Tests run: targeted U5 files, then `tsc --noEmit` (clean), then full Vitest suite.
Results: **1376 passed / 150 files; tsc clean** (was 1333/146). Live smoke: `/approvals` renders decision cards with real pending+resolved data; `/api/flow-approvals/cards` and `/api/agents/presence` both 200 JSON; presence honestly returns idle when no agent is in-window.
Known limits: presence recency is a fixed 6h window (not configurable); `waiting_approval` attributes to agents that produced a node-run in the paused run (an agent downstream of the gate that has not run yet is not shown as waiting — by design, not guessed); presence has no per-agent model/runtime line (avoided fabricating one). No Commander redesign; U6 Commander Home and Phase F remain NOT started.
Rollback: code-only (no schema). Revert the added files + the four modified files; the legacy approvals list endpoint and Phase-E resolution are untouched.

---

Change ID: **PHASE-E**
Phase: E (Human Approval + durable pause/resume)
Summary: A Human Approval node pauses a run durably and resumes without re-running any completed work.
Reason: Workflows need a real human gate (send-email / spend / publish) that survives refresh, hot-reload, and process restart — kept separate from the machine-logic Decision node.
Files added: `lib/flows/approvals.ts`, `lib/flows/executors/approval.ts`, `app/api/flow-approvals/{route,[id]/route,[id]/approve/route,[id]/reject/route}.ts`, `components/ApprovalsInbox.tsx`, `app/approvals/page.tsx`, tests `flow-approvals.test.ts` + `flow-approvals-api.test.ts`.
Files modified: `lib/db.ts` (repo `flowApprovals` + `flow_approvals` DDL/indexes), `lib/flows/{run-types,schema,engine,coordinator,node-types}.ts`, `lib/flows/executors/index.ts`, `components/flows/{FlowCanvas,InspectorPanel}.tsx`, `app/api/flows/runs/[runId]/route.ts`, `lib/nav.ts`, `lib/connectors/hermes-serve.ts`; docs + tests (`flow-engine`, `nav`, `smoke`, `smoke-api`).
Database: additive `flow_approvals` (`CREATE TABLE IF NOT EXISTS`) + `idx_flow_approvals_{run,status,node_run}`. Run status +`waiting_approval`; node-run status +`rejected`. No existing table/column changed; immutable versions untouched.
API: new `GET /api/flow-approvals`, `GET /api/flow-approvals/:id`, `POST /api/flow-approvals/:id/approve|reject` (Zod; client sends only id+decision+note). `GET /api/flows/runs/:runId` now also returns `approvals`.
Behavior: reaching an approval node → run `waiting_approval` + pending approval; Approvals inbox + Run Inspector show it; approve/reject resumes the run down the approve/reject route (rejection routes normally, is not a failed run); resume never re-runs succeeded nodes; a paused run survives restart (not reconciled to interrupted); resolution is idempotent. Hermes-originated approval events stay `hermes_approval_required` (session continuation deferred; never auto-approved).
Tests added: `flow-approvals.test.ts` (repo idempotency, engine pause, approve/reject routing, no-upstream-rerun via executor call count, restart durability, reconcile safety, resume launcher, service idempotency + not-found, no-secret context, validator runnable) + `flow-approvals-api.test.ts` (full HTTP pause→inbox→approve→resume + idempotent re-approve + 404).
Tests run: `tsc --noEmit` (clean) + full Vitest suite.
Results: 1213 passed / 138 files; tsc clean.
Known limits: no approval expiry/TTL (`expired` defined, unused); no auth layer (actor `local_operator`); Hermes-session approval continuation deferred; executors do not yet require an upstream approval for destructive side effects.
Rollback: code-only for the engine/UI/API; the `flow_approvals` table is additive and inert if unused (drop it to fully revert schema). Approval nodes become non-runnable again by reverting `executors/index.ts` + `node-types.ts`.

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

---

Change ID: **PHASE-D**
Phase: D (checkpoints D1–D7)
Summary: Logic engine — structured mapping, references, Decision/conditions, conditional edges, Transform, Parallel/Join.
Reason: Turn the Phase-C executable DAG into a real workflow logic engine (branching, structured data flow) without replacing the engine.
Files added: `lib/flows/references.ts` (reference/template/path resolver + `buildScope` + `extractReferenceRoots`), `lib/flows/conditions.ts` (condition schema + single evaluator), `lib/flows/inputs.ts` (`resolveNodeInputs` over active edges), `lib/flows/executors/{transform,decision,parallel,join}.ts`, `components/flows/InspectorPanel.tsx`; tests `flow-references`, `flow-conditions`, `flow-inputs`, `flow-transform`, `flow-branching`, `flow-validator-d`, `flow-security`.
Files modified: `lib/flows/schema.ts` (edge mapping `object` mode + structured `condition`; Decision `rules`/`defaultRoute`; Transform modes; Parallel/Join config — all additive with safe defaults), `lib/flows/engine.ts` (active-edge scheduler, skip-vs-fail, decision routing, join readiness; kept `topoOrder` + legacy `resolveIncomingInputs`), `lib/flows/registry.ts` (ctx `scope` + `sources`), `lib/flows/executors/{index,agent}.ts` (register D executors; agent serializes structured input), `lib/flows/node-types.ts` (`executable` now truthful), `lib/flows/validator.ts` (Phase-D structural checks), `components/flows/FlowCanvas.tsx` (node/edge inspectors, edge mapping/condition round-trip, run-inspector routes/skip), `app/flows/page.tsx` (copy), `tests/flow-engine.test.ts` (decision now executable → assertion uses `approval`).
Database: **no changes** — logic in version graph JSON; runtime detail in existing `flow_node_runs` JSON.
API: no route/contract changes (existing `/api/flows/*` carry the richer graph transparently).
Behavior: Decision/Transform/Parallel/Join execute; edges carry field/template/object mappings and conditions; branches route, skip, and join deterministically; Run Inspector shows selected route + skip reason.
Tests added: 68 (references 21, conditions 13, inputs 8, transform 6, branching 8, validator-d 8, security 4).
Tests run: `tsc --noEmit` clean; full Vitest suite.
Results: 1140 passed (was 1072). Live HTTP smoke: decision HIGH/LOW routing + skip, and Parallel/Join, both correct end-to-end.
Known limits: sequential execution (Parallel deterministic, not concurrent); static ref validation checks the root only; optional/default reference values deferred.
Rollback: additive; revert code. No schema to roll back.

---

Change ID: **FIX-hermes-acp-timeout-recovery**
Phase: maintenance (SEV-2 fix; see INCIDENTS.md INC-005)
Summary: A timed-out Hermes ACP prompt no longer leaves the persistent process stale-busy.
Reason: Under a workflow Agent node running a tool-using agent, a ~181s timeout left the abandoned ACP turn running; the shared single-turn process then stalled subsequent requests.
Files added: `tests/fixtures/fake-hermes-acp.mjs`, `tests/hermes-acp.test.ts`.
Files modified: `lib/connectors/hermes-acp.ts`.
Database: no changes. API: no changes.
Behavior: on prompt timeout the client sends ACP `session/cancel` + drops the leaked correlation + clears the timer, freeing the process for the next request; `initialize`/`session/new` are timeout-bounded; safe diagnostics added. Still throws `hermes_unavailable`; NO silent fallback.
Tests added: regression (fake single-turn-busy ACP agent) — normal prompt succeeds → hung prompt times out explicitly → later prompt still succeeds. Reproduced the bug before the fix.
Tests run: `tsc --noEmit` clean; targeted hermes/agent/model/flow suites; full Vitest suite.
Results: 1141 passed (was 1140). Regression fails on pre-fix code, passes after.
Known limits: default per-prompt timeout stays 180000ms (tune via `HERMES_ACP_TIMEOUT_MS` for cold, tool-heavy agents); no automatic retry (retries remain Phase G).
Rollback: revert the connector change (reintroduces the poisoning). Forward-fix preferred.

---

Change ID: **HRA2-H1**
Phase: HRA-2 (Hermes Runtime Architecture V2) — checkpoint H1 (seam + serve spike)
Summary: HermesClient application seam wrapping the current ACP path (no behavior change) + a test-only serve transport proven against a fake fixture.
Reason: Decouple ModelRouter/Agents/Flows from the Hermes transport so the future ACP→serve swap (H3) is safe. Follows the HRA-2 review + H0 GO-WITH-CONDITIONS.
Files added: `lib/connectors/hermes-client.ts` (HermesClient interface + ACP/brain-backed impl + capabilities table), `lib/connectors/hermes-serve.ts` (test-only HermesServeTransport + ServeChannel abstraction + real-WS factory for manual smoke + HermesTransportError + token redaction), `tests/fixtures/fake-hermes-serve.ts`, `tests/hermes-client.test.ts`, `tests/hermes-serve-transport.test.ts`.
Files modified: `lib/models/router.ts` (hermes strategy calls `getHermesClient()`; adapter still `brain:<name>`; `hermes_unavailable` + no-fallback preserved), `lib/connectors/hermes-acp.ts` (added read-only `hermesAcpProcessSpawned()` — no behavior change).
Database: **no changes** (no serve-token column; H2 owns any runtime config). API: no changes. UI: none.
Behavior: unchanged for production — ACP remains the Hermes transport; the router's hermes output (text/toolCalls/usage/strategy/adapter/fallbackUsed) is byte-for-byte the same. serve transport is disabled/test-only.
Tests added: 19 (client seam 6 incl. INC-005-through-seam; serve transport 13 incl. auth/session/stream/tool/interrupt/recovery/error/malformed/connection-loss + token-never-leaks security). Real Hermes not required for the suite.
Tests run: `tsc --noEmit` clean; targeted hermes/router/flow/security suites; full Vitest suite.
Results: 1160 passed (was 1141). No production serve traffic enabled.
Known limits: serve token acquisition lifecycle unresolved (H2/H3); MCP `'unknown'`, skills `'unknown'` (unverified); true-parallel concurrency unproven; persistent Hermes memory is cross-session (product decision pending). ACP concurrency stays globally serialized.
Rollback: revert the router import/branch + delete the new files; ACP path is untouched underneath.

---

Change ID: **HRA2-H2**
Phase: HRA-2 (Hermes Runtime Architecture V2) — checkpoint H2 (RuntimeManager + Settings status UX)
Summary: HermesRuntimeManager (discovery/health/lifecycle/ownership/token) + a truthful "Hermes Runtime" Settings panel. Orthogonal to production ACP transport.
Reason: H3 needs a truthful local-runtime picture and a settled token lifecycle before moving agent traffic to serve.
Files added: `lib/connectors/hermes-runtime.ts` (HermesRuntimeManager + RuntimeDeps DI + defaultRuntimeDeps), `app/api/settings/hermes-runtime/route.ts` (Zod GET/POST: detect/health/configure/start/stop), `components/HermesRuntimeSettings.tsx`, `tests/hermes-runtime.test.ts`.
Files modified: `app/settings/page.tsx` (render the panel), `tests/smoke-api.test.ts` (ignore the runtime GET from the 200-required net — it probes the real binary/serve).
Database: NO migration. Non-secret runtime config uses the existing `meta` KV (`hermes_runtime_mode/host/port/bin/enabled/last_check/last_success/last_error/last_version`). Serve token stored in `.env.local` (`HERMES_SERVE_TOKEN`) only.
API: added `GET/POST /api/settings/hermes-runtime`. No change to model/agent/flow routes.
Behavior: production agent traffic UNCHANGED (ModelRouter → HermesClient → ACP). New: Settings ▸ Hermes Runtime shows install/version/path, runtime state/mode/ownership/endpoint, `/api/status` health, tri-state capabilities, token presence, ACP-is-production banner, and the persistent-memory boundary. Optional managed start/stop with strict ownership guards.
Tests added: 22 (discovery 6, health/identity 6, ownership/lifecycle 5, token 4, contract/security 1 incl. no-`serve --status` + argv-only guards). All fully faked — no real Hermes required.
Tests run: `tsc --noEmit` clean; hermes-runtime + smoke-api + orphans + smoke; full Vitest suite.
Results: 1182 passed (was 1160). Real read-only smoke on this machine: installed v0.20.0 (PATH), serve unreachable/honest, token missing, productionTransport acp.
Known limits: token attach/handoff lifecycle for an EXTERNAL running serve is not fully solved (external mode requires a user-supplied token); MCP `unknown` / skills `unverified`; no auto-restart/heartbeat (H3); remote (H4) not implemented.
Rollback: delete the new files + revert the settings page + smoke-api ignore line. No schema to roll back.

---

Change ID: **HRA2-H3**
Phase: HRA-2 — checkpoint H3 (production serve integration + safe cutover)
Summary: `hermes serve` is a selectable, eligibility-gated production transport (default ACP, no silent fallback), validated live incl. the Gmail workflow.
Reason: Fix the ACP slow-vs-dead poisoning by moving agent traffic (optionally) onto Hermes's own multi-client serve runtime, reversibly.
Files added: `lib/connectors/hermes-caps.ts` (shared capabilities — breaks the client↔serve value cycle); `tests/hermes-serve-production.test.ts`.
Files modified: `lib/connectors/hermes-client.ts` (transport selection: serve vs brain; bounded-concurrency limiter; ServeHermesClient; `productionTransportMode`; re-export caps), `lib/connectors/hermes-serve.ts` (layered timeouts, stream-inactivity timeout, approval-event → `hermes_approval_required`, connect-vs-auth error, session source, diagnostics; `createServeConfig` options), `lib/connectors/hermes-runtime.ts` (`productionTransport` from meta + serve `eligibility`), `lib/models/router.ts` (`getHermesClient(db)`), `app/api/settings/hermes-runtime/route.ts` (`set_transport` action, eligibility-gated), `components/HermesRuntimeSettings.tsx` (transport selector + rollback), `tests/fixtures/fake-hermes-serve.ts` (APPROVAL/SILENT markers), `tests/hermes-runtime.test.ts` (eligibility/transport tests).
Database: NO migration. New non-secret `meta` keys: `hermes_production_transport` (default acp), `hermes_serve_concurrency`. Token stays in `.env.local`.
API: `POST /api/settings/hermes-runtime {action:'set_transport', transport}`; GET status gains `productionTransport` + `eligibility`.
Behavior: default UNCHANGED (ACP). When serve is explicitly selected (eligible), agent traffic routes through the serve WS/JSON-RPC transport, one isolated session per node run, bounded concurrency, layered timeouts + interrupt on timeout, approval events surfaced (not auto-answered). No silent fallback.
Tests added: H3 (selection, no-silent-fallback via router, bounded concurrency, approval, inactivity timeout, connect-vs-auth, two-session) + runtime eligibility/transport. All faked — no real Hermes required.
Tests run: `tsc --noEmit` clean; hermes suites; full Vitest suite (green; the known seed/api pair is flaky under parallel load, green on re-run).
Results: 1194 passed (was 1182). LIVE: concurrency independent; interrupt+recovery; serve workflow adapter `brain:hermes-serve` (7.1s) vs ACP `brain:hermes-acp` (15.8s); **Gmail workflow success in 113.7s with 37/37 /api/status probes healthy during the turn, Transform+Output executed, follow-up run clean (no poisoning)**; ACP rollback works.
Known limits: MCP-specific execution over serve not isolated (server-side tools incl. real email DID run) → partial; skills unverified; persistent-memory isolation (dedicated profile) pending; remote (H4) not implemented. Decision: GO WITH CONDITIONS.
Rollback: set transport back to acp (UI/API), or revert the new files; ACP path untouched.

---

Change ID: **UX-FLOWS-EDIT-1**
Phase: UX fix (post-E). Phase F NOT started.
Summary: Fix four /flows editing gaps — workflow delete/archive + rename, canvas node delete with edge cleanup, Input-node clarity, and a per-node description. No Phase-E approval logic changed.
Reason: Manual testing found you could create workflows (incl. duplicates) but not delete one, could not delete a canvas node, and the Input node was confusing to edit.
Files added: lib/flows/graph-ops.ts (pure node/edge removal + keyboard-delete guard), lib/flows/workflow-admin.ts (backend delete-vs-archive service), tests/flow-graph-ops.test.ts, tests/flow-workflow-admin.test.ts, tests/flow-workflow-admin-api.test.ts, tests/flow-node-edit.test.ts.
Files modified: lib/flows/schema.ts (optional node `description`), lib/db.ts (archived_at column + migrateFlowWorkflowsTable + all()/get() filter + hasHistory/archive/unarchive; rowToWorkflow), app/api/flows/[id]/route.ts (DELETE → removeOrArchiveWorkflow; PATCH name trim/non-empty), components/flows/FlowWorkspace.tsx (Rename + Delete header, named confirm dialog, safe selection move), components/flows/FlowCanvas.tsx (deleteNode + Delete/Backspace handler guarded, deleteKeyCode disabled, description passthrough), components/flows/InspectorPanel.tsx (Delete-node button, description field, Input default-value clarifier), tests/flows-migration.test.ts (archived_at + hasHistory).
Database: ADDITIVE + idempotent — `flow_workflows.archived_at TEXT` (fresh via CREATE TABLE, existing via ALTER). No destructive change; no other table touched.
API: DELETE /api/flows/:id now returns `{ ok, mode: 'deleted'|'archived', reason }` (backend decides; 404 if missing). PATCH /api/flows/:id name is trimmed + non-empty. Contracts otherwise unchanged.
Behavior: /flows header gains Rename + Delete (named confirm, never one-click); history-bearing workflows archive (audit preserved) instead of hard-delete; canvas nodes delete via button or Delete/Backspace (guarded against deleting while typing), removing connected edges; deletion is draft-only (published versions unchanged until Publish); Input inspector separates "default value (fallback)" from the runtime Starting Input; all nodes gain an optional description. Legacy /brain agent_flows untouched.
Tests added: 29 (node/edge removal + keyboard guard; delete-vs-archive incl. history/agent_flows-safety/injection-id; HTTP delete/archive/404 + rename validation; node-edit + node-delete round-trip; migration/hasHistory).
Tests run: `tsc --noEmit` clean; targeted flow suites; full Vitest suite.
Results: 1242 passed / 142 files (was 1213). LIVE (running dev server on 4100): created "TEMP DELETE TEST" → Rename/Delete header shown → named confirm dialog → DELETE 200 (mode deleted, no history) → gone from list; re-DELETE 200-then-404 (idempotent, refresh does not restore); added Input node → inspector shows label/description/default-value(+clarifier)/format + Delete-node; Delete-node removed the node (1→0) and closed the inspector.
Known limits: node-delete keyboard/edge cleanup and node-edit round-trip are covered by unit tests (test env is `node` — no jsdom/RTL, so no component-render tests). Archive has no purge/restore UI yet (unarchive exists in the repo). Approval expiry/TTL + auth layer remain deferred (Phase E follow-ons).
Rollback: revert the two new lib files + the route/component edits (code rollback). The `archived_at` column is additive and harmless to leave; to drop it would require a manual migration (not recommended).

---

Change ID: **UX-FLOWS-WORKSPACE-1**
Phase: UX improvement (post-E). Phase F / G / HRA-2 H4 NOT started.
Summary: Collapsible /flows workspace — main-sidebar collapse, workflow-list collapse, and a Focus Canvas overlay — to give the React Flow canvas more room. Presentation state only.
Reason: On /flows the main app sidebar + workflow list consumed too much horizontal space, leaving the canvas too narrow for larger workflows.
Files added: lib/layout-prefs.ts (nav width + persisted-pref helpers + no-flash init script), lib/flows/workspace-view.ts (pure WorkspaceView toggles/panelsVisible), tests/flows-workspace-view.test.ts.
Files modified: app/layout.tsx (inject NAV_INIT_SCRIPT; content shell offset via ml-[var(--nav-w,232px)]), components/Sidebar.tsx (collapse to icon rail: state + localStorage + mount-synced --nav-w/data-nav, tooltips, a11y labels, inline-var width), components/flows/FlowWorkspace.tsx (workflow-list collapse + reopen tab, Focus Canvas overlay reusing the SAME FlowCanvas element via stable keys, Escape + Ctrl/Cmd+Shift+F), components/flows/FlowCanvas.tsx (Focus/Exit toolbar button via focusMode/onToggleFocus props; Escape closes the inspector when not typing and not in focus), app/globals.css (scroll-lock behind the focus overlay).
Database: NONE.
API: NONE (no route/contract change; collapsing/focus never calls the backend).
Behavior: main sidebar + workflow list each collapse independently (persisted); Focus Canvas maximizes the canvas as an app overlay (not OS fullscreen), keeping Save/Publish/Run + controls/minimap; Escape exits focus (or closes the inspector); Ctrl/Cmd+Shift+F toggles focus. Selection, unsaved draft edits, and the React Flow viewport survive every toggle (same FlowCanvas instance, no refetch, no remount). No workflow-execution behavior changed.
Tests added: 10 (toggle main sidebar / workflow list / enter-exit focus / focus-exit restores prior layout / panelsVisible / immutability / no graph fields; pref parse+fallback+round-trip; navWidth).
Tests run: tsc --noEmit clean; targeted flows-workspace-view suite; full Vitest suite.
Results: 1252 passing / 143 files (was 1242). LIVE (dev server on 4100): (A) main sidebar collapses to 64px icon rail, content offset follows, persists across reload; (B) workflow list collapses → canvas grew 374px→594px, selection + 3 nodes preserved, persisted; (C) draft safety — collapse/focus fired NO /api/flows/:id refetch and did not remount FlowCanvas; (D) Focus overlay 658x516 with Save/Publish/Run + minimap + controls, Escape exits and restores the prior layout exactly; (E) 3-node HUMAN TEST workflow stayed aligned across every resize. Fixed a real bug found during smoke: the Sidebar now syncs --nav-w/data-nav on mount (the head init script only runs on a full document load, so a client-side transition previously left the width unset).
Known limits: node/edge inspector remains a bounded side column when a node is selected (bounded width, closes on empty-canvas click or Escape) — not converted to a floating overlay. Focus mode is session-only (not persisted) by design. Component-level UX is validated by pure unit tests + live manual smoke (the test env is Node — no jsdom/RTL).
Rollback: revert the listed files; the two new lib modules and the localStorage keys are additive and harmless to leave. No schema/API to roll back.

---

Change ID: **UX-U1-CONTEXT-ENVELOPE**
Phase: UX Foundation U1 (context only). U2 Commander NOT started; Phase F NOT started.
Summary: One tiny, typed, app-wide Context Envelope that records what the user is currently looking at (identifiers + small flags only), so a future AI surface can resolve "this workflow/node/run" without importing page-specific stores.
Reason: The U1 foundation for an AI-native command surface (Commander) — a read-only context boundary. Deliberately minimal.
Files added: lib/context-envelope.ts (IgrisContextEnvelope type + pure transitions + useSyncExternalStore singleton + useIgrisContext hook + publish helpers), components/ContextRouteSync.tsx (route→surface publisher, renders null), tests/context-envelope.test.ts.
Files modified: app/layout.tsx (mount ContextRouteSync), components/flows/FlowCanvas.tsx (publish workflow/node/edge/run + draft flag on selection change; clear on unmount).
Database: NONE.
API: NONE (no route/contract change; the envelope is in-memory client state and triggers no network request).
Behavior: on navigation the envelope updates route + surface and clears stale entity ids when the surface changes; on /flows it reflects the selected workflow/node/edge/run and draft flag, clearing stale node/edge/run when the workflow changes and all flow context when the canvas closes. No visible UI change. It executes nothing and mutates no draft/version/run.
Security/privacy: identifiers + booleans/number only. Never secrets, tokens, auth headers, email content, prompts, LLM responses, tool arguments, or graphs/payloads (ENVELOPE_KEYS allow-list enforced by test). context_json/secret.request content is never referenced.
Tests added: 16 (default context; surface mapping + fallback; route/surface update; same-surface keeps selection; navigate-away clears flow context; workflow/node/edge/run selection; workflow change clears stale node/edge/run; clearFlow keeps route/surface; agent/approval transitions; allowed-keys privacy boundary / no payload fields; immutability of inputs incl. frozen objects; store publish/subscribe singleton).
Tests run: tsc --noEmit clean; targeted context-envelope suite; full Vitest suite.
Results: 1268 passing / 144 files (was 1252). No dev-server verification needed — no observable UI.
Known limits: /agents and /approvals publish only route/surface (the current UI has no persistent single-selection there — AgentBuilder "selected" is tool-selection). The envelope supports agentId/approvalId and publishAgentContext/publishApprovalContext exist for when those surfaces gain selection (or U2 wires them). workflowDraft is reported true whenever the canvas is open (the canvas edits the draft); a run of a published version is conveyed via runId + workflowVersion rather than flipping workflowDraft.
Rollback: revert the two new files + the layout/FlowCanvas edits. No schema/API to roll back.

---

Change ID: **UX-U2-COMMANDER**
Phase: UX Foundation U2 (unified command surface — recognition only). U3 Plan→Preview→Execute NOT started; Phase F NOT started.
Summary: One global Commander (Ctrl/Cmd+K) unifying the old CommandPalette (GO) and the Conductor brain (ASK) with a third DO lane that RECOGNIZES action requests but never executes them. Context-aware via the U1 envelope.
Reason: U2 of the AI-native interface — a single context-aware operating surface instead of two half-assistants (palette + Conductor).
Files added: lib/commander.ts (pure classifier / slash routes / GO resolution over nav+palette / context describe+build / unresolved-reference honesty / DO recognizer / toggle predicate), components/Commander.tsx (the ⌘K surface), tests/commander.test.ts.
Files modified: app/layout.tsx (mount Commander instead of CommandPalette), tests/nav.test.ts (DIGIT_VIEWS invariant repointed CommandPalette→Commander).
Files deleted: components/CommandPalette.tsx (fully superseded by Commander; search logic remains in lib/palette).
Database: NONE.
API: NONE new. ASK reuses the existing /api/agents/conductor/chat (read/reasoning) with identifiers-only context. GO uses client navigation. DO calls nothing.
Behavior: ⌘K opens the Commander (Esc closes; digit 1–9 jumps + the Topbar 'alex:palette' event preserved). Live context indicator from useIgrisContext(). GO navigates the canonical sidebar pages + agent/tool commands (nav-derived so approvals/flows/models/skills/tasks/g-brain all resolve) and slash commands. ASK grounds on envelope IDs and answers honestly when referenced context is missing (no LLM call). DO shows a proposed-action card and explicitly does not run anything. The Conductor dock is unchanged (same brain, long-lived chat).
Safety: GO navigation only (non-destructive); ASK cannot mutate; DO never executes in U2 (no run/delete/publish/provider-change/send/approve/auto-approval). No secrets in Commander context (identifiers only).
Tests added: 16 (GO/ASK/DO classification; slash + unknown-slash-is-GO; forced-lane correction; GO resolution incl. all canonical pages via nav; navToCommands/mergeCommands dedupe; describeContext; buildAskContext identifiers-only privacy; unresolvedReferences honesty; recognizeDoAction requires-preview; isCommanderToggle).
Tests run: tsc --noEmit clean; targeted commander suite; full Vitest suite.
Results: 1284 passing / 145 files (was 1282 before this change; net +16 vs the pre-U2 1268, with CommandPalette's orphan check resolved by deletion). LIVE (dev server on 4100): (A/E) "open approvals" GO navigated to /approvals; (B) context indicator showed "Flows › wf-… › node …"; (C) "why did this run fail?" with no run selected returned "Nothing is selected for this run" with NO conductor request; (D) "run this workflow" recognized as DO, "IGRIS did not run it", and network showed only GETs — no mutation POST.
Known limits: /agents and /approvals still publish only route/surface to the envelope (no persistent single-selection there yet), so ASK about "this agent/approval" resolves only when U1 later publishes those ids. DO recognition is verb-based (heuristic); the user can correct the lane. ASK depth is whatever the existing Conductor endpoint resolves from ids — no new resolution service was added. Commander is validated by pure unit tests + live manual smoke (test env is Node — no jsdom/RTL).
Rollback: revert layout to mount a palette, restore CommandPalette.tsx, remove Commander + lib/commander. No schema/API to roll back.

---

Change ID: **UX-U3-PREVIEW-EXECUTE**
Phase: UX Foundation U3 (Commander DO lane — Plan → Preview → Execute). U4 Activity Stream NOT started; Phase F NOT started.
Summary: The Commander DO lane became a safe, typed, preview-gated action system. A DO utterance is recognized as ONE typed action from a closed allow-list, an authoritative Preview is built from existing backend GETs, and the action executes through existing mutation APIs ONLY on an explicit human confirm. No side-effecting action bypasses Preview.
Reason: U3 of the AI-native interface — lets the Commander *act* without ever becoming autonomous: every mutation is human-confirmed, typed, and routed to a vetted existing endpoint.
Files added: lib/commander-actions.ts (typed CommanderAction allow-list; per-type registry with risk + required context; recognizeCommanderAction; previewPlan/executePlan route maps; buildRun/Publish/Delete/Approval/Hermes previews; formatResult), tests/commander-actions.test.ts.
Files modified: components/Commander.tsx (DO state machine idle→loading→preview→executing→result/error; Ctrl/Cmd+Enter confirm; ref-guarded single-submit; result/error cards), app/api/flows/[id]/route.ts (additive read-only draftValidation on GET).
Database: NONE.
API: NONE new. Reuses POST /api/flows/:id/runs, POST /api/flows/:id/versions, DELETE /api/flows/:id, POST /api/flow-approvals/:id/approve|reject, POST /api/settings/hermes-runtime {set_transport}. GET /api/flows/:id gains an additive `draftValidation` field (publish preview authority). No generic execute endpoint.
Behavior: In DO, a recognized action shows a proposal (risk badge) → Enter builds a Preview from live data (GET only, never executes) → Ctrl/Cmd+Enter (or Confirm) executes once through the existing mutation → result card (run id + Open, archive/delete mode, "already resolved", or verbatim failure + reasons). Plain Enter never executes. Blocked previews (never-published, invalid draft, already-resolved approval, serve-ineligible) disable Confirm. Missing context ("run this workflow" with nothing selected) is reported, not guessed. Human Approval is never auto-approved. GO/ASK unchanged and cannot mutate.
Tests added: 30 (recognition→typed proposal for run/publish/delete/approve/reject/hermes; missing-context blocks; unknown text → unknown; closed type allow-list rejects unknown ids; executePlan/previewPlan exact routes + id URL-encoding + preview-is-GET; run/publish/delete/approval/hermes preview builders incl. blocked states + secret-free approval; result formatting incl. archive-vs-delete, already-resolved, honest failure w/ reasons).
Tests run: tsc --noEmit clean; full Vitest suite.
Results: 1314 passing / 146 files (was 1284 pre-U3; +30). LIVE (dev server 4100, /flows, HUMAN TEST selected): (A) "run this workflow" → DO recognized, risk MEDIUM, context "Flows › wf-ab7d…"; Enter built the PREVIEW (Workflow: HUMAN TEST, Published v2, effects incl. "Human Approval gates remain active") with network showing GETs only — NO run POST; Ctrl+Enter → "Workflow started · Run run-371d…"; run count went 4→5 (exactly ONE run per confirm). Caught + fixed a real double-submit: the mutation had been placed inside a setState updater, which React StrictMode double-invokes — moved it out behind a synchronous ref guard; re-verified one-confirm-one-run on a fresh tab with a clean console. Additive draftValidation confirmed live. Publish/delete/approval/hermes share the identical funnel and are covered by unit tests (not exercised live to avoid creating destructive test data).
Known limits: DO recognition is deterministic keyword parsing (the user can correct the lane); the initial action set is the five safe existing-boundary operations (arbitrary tool execution intentionally excluded). Approval actions require an approvalId in the envelope — /approvals does not yet publish a single-selection id (U1 follow-on), so "approve this" only proposes from a surface that has one. The "unpublished draft edits" run warning is an honest heuristic (draft saved after the published version), not a graph diff. Commander is validated by pure unit tests + live manual smoke (test env is Node — no jsdom/RTL).
Rollback: revert components/Commander.tsx to the U2 recognition-only DO lane, delete lib/commander-actions.ts + tests, revert the GET draftValidation addition. No schema/API to roll back.

---

Change ID: **UX-U4-ACTIVITY-STREAM**
Phase: UX Foundation U4 (Activity / Ops Stream — read-only operational projection). U5 NOT started; Phase F NOT started.
Summary: One canonical, collapsible Activity dock that projects a normalized, newest-first timeline over existing run/approval/node-run state — "what is IGRIS doing now, what just happened, what needs attention?" — with no new table, no mutation, and no WebSockets.
Reason: U4 of the AI-native interface — a single operational surface derived from authoritative truth, reusable later by Home.
Files added: lib/activity/model.ts (pure ActivityEvent model + builders + sort/filter/limit + navHref + poll guard), lib/activity/service.ts (buildActivityFeed aggregator; authoritative agent-id resolution via version graph, cached; sanitized), app/api/activity/route.ts (GET, Zod, bounded), components/ActivityDock.tsx (collapsible right dock), tests/activity.test.ts.
Files modified: lib/db.ts (+ read-only flowRuns.recent / flowNodeRuns.recent / flowApprovals.recent), lib/layout-prefs.ts (+ ACTIVITY_OPEN_KEY, ACTIVITY_W), app/layout.tsx (mount ActivityDock; content marginRight now calc(--conductor-w + --activity-w)), components/Commander.tsx (trivial GO "show activity"/"show errors" → open dock), tests/smoke-api.test.ts (register the new GET route in the "no route escapes" net).
Database: NONE (no new table, no column). Three additive read-only repo queries only.
API: NEW read-only GET /api/activity?limit=50&filter=all (Zod; hard cap 200). No mutation API. Reuses existing run/approval data.
Behavior: A right dock (collapsible, persisted) lists workflow/approval/error and reliably-derived agent events, newest-first with deterministic tiebreak; needs-attention (failures, waiting approvals) are flagged; filters All/Flows/Agents/Approvals/Errors are presentation-only; clicking navigates to /flows /approvals /agents. Polls every 6s (no overlap, unmount-safe), shows "Activity unavailable / Retry" on failure, never presents stale data as fresh. Main surface grows when the dock is collapsed.
Tests added: 22 (run/approval/node normalization incl. error categorization and no-fabricated-terminal-state; agent resolved vs unresolved; non-agent failures-only; newest-first + deterministic tie ordering; category filters; buildFeed limit + hard cap; nav mapping; canStartPoll overlap guard; hydration-safe collapsed default; long-error truncation; no payload/secret keys on events; + service test over an in-memory db proving run/approval/node projection and that starting_input / node output / approval context_json never leak). Plus the smoke-api net gained the activity route.
Tests run: tsc --noEmit clean; full Vitest suite.
Results: 1333 passing / 146 files (was 1314 pre-U4). LIVE (dev server 4100): GET /api/activity → 200, 50 bounded events spanning workflow+approval+agent+error, newest-first, secret-scan clean; agent events (agent_completed / agent_failed) resolved from real version graphs. Panel: opened via Commander/event → header+filters render, --activity-w=340px (content shrinks); Errors filter showed only failures ("ahent failed", "Gmail Worker failed"); collapse → --activity-w=0px (content grows) + pref persisted; reload kept it collapsed with NO hydration mismatch (verified on a fresh tab: only a pre-existing static-asset 404 in console, no dep-array/hydration warnings).
Known limits: /flows has no run/workflow deep-link param yet, so workflow/error events navigate to the canonical /flows surface (not a preselected run) — U5's selection work can add it. Agent events require a resolvable agent node in the immutable version graph; otherwise the event stays workflow/node (never guessed). Aggregation is one bounded query per source + in-memory merge (documented scaling note in ARCHITECTURE.md §9d) — replace with a UNION-ordered query or cursor if history grows large. Panel is validated by pure unit + service tests + live manual smoke (test env is Node — no jsdom/RTL).
Rollback: unmount ActivityDock from the layout (revert marginRight to conductor-only), delete lib/activity/* + components/ActivityDock.tsx + app/api/activity + tests, remove the three repo recent() methods + the two layout-prefs constants + the Commander GO branch, and un-register the route in smoke-api. No schema to roll back.
