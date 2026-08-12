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
