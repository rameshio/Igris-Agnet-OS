# DECISIONS — architecture decision log

> Why the architecture is the way it is. Do not casually reverse these — each
> exists for a reason and has consequences. New significant decisions append
> here with the same structure.

Format: **Decision · Reason · Consequences · Phase.**

---

### D1 — `/flows` is separated from `/brain`
- **Decision:** The visual workflow orchestrator is its own route/domain; the knowledge graph + memory stay on `/brain`.
- **Reason:** They share the word "graph" and nothing else. Merging them conflates orchestration (what executes) with knowledge (what is known).
- **Consequences:** Workflow engine never becomes the knowledge graph; the legacy canvas was removed from `/brain`; `/brain` is knowledge-only.
- **Phase:** A.

### D2 — Multiple, named, versioned workflows
- **Decision:** Support many workflows, each with metadata and versions, instead of the single legacy "main" canvas.
- **Reason:** Real orchestration needs reusable, nameable, historically-stable workflows.
- **Consequences:** `flow_workflows` + `flow_versions`; legacy `agent_flows.main` imported once as `wf-main`.
- **Phase:** A.

### D3 — Draft (mutable) vs Version (immutable)
- **Decision:** The draft graph is editable; publishing freezes an immutable version. Runs reference a version.
- **Reason:** A historical run must always have a stable definition; later edits must not rewrite the past.
- **Consequences:** Save ≠ Publish ≠ Run; runtime state never written into the definition JSON.
- **Phase:** A / C.

### D4 — App-wide model provider connections
- **Decision:** Provider connections are app-wide (`model_provider_connections`), not owned by `/flows`. (An earlier plan's `flow_provider_connections` name was explicitly rejected.)
- **Reason:** Models power agents, Conductor, and flows alike — they are shared infrastructure.
- **Consequences:** Flows reference agents; agents own model strategy; the model layer sits under everything.
- **Phase:** B.

### D5 — Hermes is a first-class brain, not an API-key provider
- **Decision:** Hermes is a runtime/brain reached over ACP (persistent process), shown separately from direct providers.
- **Reason:** Hermes provides tools/MCP/memory/agentic behavior a raw API key does not; modeling it as a provider card would misrepresent it.
- **Consequences:** `strategy:'hermes'` routes to the active brain; the Models board shows a separate "Brains" section with honest (unprobed) status.
- **Phase:** B.

### D6 — Auto Router intentionally stubbed
- **Decision:** `strategy:'auto'` exists as an interface but fails with `auto_not_implemented`.
- **Reason:** Real routing needs execution telemetry (latency/tokens/cost/success) that only later phases produce. Faking intelligent routing would be dishonest.
- **Consequences:** Auto never silently picks a model; the UI labels it "not fully available yet."
- **Phase:** B.

### D7 — Model strategy encoded in the existing agent `model` string
- **Decision:** Keep `custom_agents.model` as the source of truth; encode strategy in it (`''`→hermes, `auto`→auto, `providerId:modelId`→fixed). Expose explicit `{strategy, config}` types above storage.
- **Reason:** Zero-migration, fully backward compatible; old values keep working.
- **Consequences:** No new agent columns; `lib/models/settings.ts` is the single parse/serialize point.
- **Phase:** B.

### D8 — Workflow outputs are NOT auto-saved to G-Brain
- **Decision:** The execution engine never calls the knowledge write path. Memory is explicit (Phase F nodes).
- **Reason:** Transient run data should not pollute permanent knowledge; conservative-by-default memory.
- **Consequences:** The legacy engine's auto-save behavior is deliberately not reproduced; enforced by a structural test.
- **Phase:** C (rule set in B).

### D9 — Execution in a backend engine, not React
- **Decision:** Orchestration/execution lives in `lib/flows/*` (engine, coordinator, executors); the canvas only renders definitions + overlays run state.
- **Reason:** Testability, separation of concerns, no execution logic coupled to UI.
- **Consequences:** Engine is unit-testable with the stub brain; the UI polls persisted runs.
- **Phase:** C.

### D10 — Polling instead of mandatory WebSockets
- **Decision:** Runs are persisted and pollable (~1s); no WebSocket infrastructure.
- **Reason:** Hermes calls take seconds; a browser must not hold one long request. Polling is simple and sufficient for a local app.
- **Consequences:** `POST` returns a run id immediately; `GET` polls until terminal.
- **Phase:** C.

### D11 — In-process run coordinator; active registry on `globalThis`
- **Decision:** Runs execute fire-and-forget in the persistent Next process via `FlowRunCoordinator`; the in-flight run set is pinned to `globalThis`.
- **Reason:** No queue/Redis for a local app. Next bundles each API route separately, so a plain module-level Set is NOT shared between the start route and the read route — `globalThis` makes it a true process singleton. (This fixed a real bug where runs were falsely marked `interrupted`; see `INCIDENTS.md` INC-001.)
- **Consequences:** Stale runs (running but untracked, e.g. after restart) reconcile to `interrupted` on read; no auto-resume.
- **Phase:** C.

### D12 — Legacy system retained during migration
- **Decision:** `agent_flows`, `/api/agent-flows`, `AgentFlowCanvas`, `lib/agents/flow-run.ts` are kept operational.
- **Reason:** Backward compatibility until `/flows` reaches full parity and retirement is explicitly approved.
- **Consequences:** New features must not build on legacy; see `LEGACY.md`.
- **Phase:** A–C.

### D13 — Fail-fast execution (no retries/fallback in Phase C)
- **Decision:** A failed node fails the run and skips dependents; no retry/fallback/error-routes.
- **Reason:** Reliability features need explicit design (Phase G) and honest recording; silent fallback is banned.
- **Consequences:** `flow_runs`/`flow_node_runs` reserve fields for future fallback recording; `fallbackUsed` is always false today.
- **Phase:** C.

### D14 — One reference resolver + one condition evaluator (no eval)
- **Decision:** All `{{Node.field}}` parsing goes through `lib/flows/references.ts`; all conditions (Decision nodes AND conditional edges) go through the single evaluator in `lib/flows/conditions.ts`. Lookup is property/path only — no `eval`, `Function`, or dynamic code.
- **Reason:** Prevent two competing structured-state/condition systems and eliminate code-execution attack surface. Path lookup is read-only and rejects `__proto__`/`prototype`/`constructor` (prototype-pollution safe).
- **Consequences:** Executors never parse `{{...}}` themselves; adding a mapping/condition site reuses the resolver. A whole-string reference preserves the value's native type; inline references stringify deterministically.
- **Phase:** D.

### D15 — Missing references fail clearly; strict-but-safe condition typing
- **Decision:** An unresolved required reference throws `workflow_reference_not_found` — never a silent empty string. `equals`/`not_equals` are strict (no coercion: `"75" !== 75`); numeric comparators apply an explicit, safe numeric conversion.
- **Reason:** Silent substitution hides misconfiguration; strict equality avoids surprising coercion while numeric ops stay practical when a score arrives as a numeric string.
- **Consequences:** Optional/default reference values are deferred; publish-time validation checks only the reference ROOT (node exists), since deeper paths depend on runtime values.
- **Phase:** D.

### D16 — Active-edge scheduler: skip vs fail, and deterministic branch/join
- **Decision:** Extend (not replace) the Phase-C topological engine with an active-edge model. An edge delivers data only when its source succeeded AND is selected (Decision route match, or conditional-edge truth). A node reachable by no active edge is **skipped**; a node that errors while executing is **failed**. Decision uses FIRST-MATCH exclusive routing; multiple true conditional edges all activate. Join waits for all ACTIVE branches (topological visit guarantees predecessors are terminal, so a skipped branch never stalls it) and keys branches by a stable label.
- **Reason:** Correct branching/join semantics without a rewrite or races; sequential execution preserves parallel-branch independence (correctness over literal concurrency).
- **Consequences:** Unreachable nodes are deterministically skipped (no eternal "running"); Parallel is a control node, not literal concurrency. Runtime detail (selected route, skip reason, join branches) persists in existing `flow_node_runs` JSON — no new tables.
- **Phase:** D.

### D17 — HermesClient seam; serve validated but ACP stays primary (HRA-2 H1)
- **Decision:** Introduce one canonical `HermesClient` seam (`lib/connectors/hermes-client.ts`, `chat`/`health`/`capabilities`) that the ModelRouter's `hermes` strategy calls instead of depending on ACP details. In H1 the only production implementation wraps the active brain (ACP by default) — **zero runtime behavior change**. A separate **test-only** `HermesServeTransport` (`lib/connectors/hermes-serve.ts`) implements the same interface over the H0-verified `serve` protocol (WS + JSON-RPC 2.0, `/api/status`, `session.create`/`prompt.submit`/`session.interrupt`) to prove the seam supports the future H3 transport swap. `hermes serve` is **NOT** wired to production traffic.
- **Reason:** Decouple Agents/Flows/ModelRouter from the transport so the eventual ACP→serve swap (H3) is safe and incremental, per the HRA-2 architecture review. Keep H1 boring: a seam + a proven-but-disabled alternative, not a switch.
- **Consequences:** ModelRouter stays a pure strategy dispatcher (no process/lifecycle/token concerns — those are H2/H3). Capabilities are **tri-state**; MCP/skills stay `'unknown'` (H0 unverified). ACP has no independent health probe, so `HermesClient.health()` for ACP returns `status:'unknown', independentProbe:false` (never faked). The `hermes_unavailable` router contract and **no-silent-fallback** invariant are unchanged. Serve token lifecycle is unresolved and required before H3. INC-005 timeout/cancel/recovery behavior is preserved (pure delegation).
- **Phase:** HRA-2 H1.

### D18 — HermesRuntimeManager: ownership + token lifecycle (HRA-2 H2)
- **Decision:** Add a backend `HermesRuntimeManager` (`lib/connectors/hermes-runtime.ts`) that discovers the local Hermes binary, probes serve health via `GET /api/status` (never `serve --status`), models runtime state/mode/ownership, and can safely start/stop an IGRIS-managed serve. It is ORTHOGONAL to production agent traffic (still `ModelRouter → HermesClient → ACP`). Non-secret runtime config lives in the existing `meta` KV store (no migration); the serve dashboard token lives ONLY in `.env.local` (`HERMES_SERVE_TOKEN`) — never SQLite, never the frontend, never logs.
- **Reason:** H3 needs a truthful runtime picture + a settled token lifecycle before moving agent traffic to serve. The manager must not conflate "reachable on 9119" with "IGRIS owns it" (serve is designed to be shared), and must never kill an external/shared server.
- **Consequences (guards):** Ownership = only a process IGRIS launched whose PID is alive (`managed`); anything else reachable is `external`. Stop kills the exact owned PID only — never `serve --stop`. Start attaches (does not relaunch) when a healthy Hermes already runs, and fails `port_conflict` on a non-Hermes service (never kills it). Binary candidates are accepted only if `<bin> --version` prints a Hermes banner (existence alone is insufficient); `/api/status` must look Hermes-shaped to be trusted (§31). Token: managed start generates it (`crypto.randomBytes`) and passes it to serve via ENV (`HERMES_DASHBOARD_SESSION_TOKEN`), never on the command line; external mode takes a user-supplied token; presence-only (`tokenConfigured`) is exposed. Capabilities reuse the H1 tri-state (MCP/skills stay `unknown`). `supported` is always `'unknown'` (no approved minimum version yet). Fully dependency-injected so the default test suite never spawns a process or hits the network.
- **Open before H3:** production token attach/handoff lifecycle (managed vs external), MCP/skills parity, true-parallel concurrency, and the persistent-Hermes-memory product decision.
- **Phase:** HRA-2 H2.

### D19 — Serve as a SELECTABLE production transport; ACP stays default (HRA-2 H3)
- **Decision:** `hermes serve` is now a **selectable** production transport for agent traffic, chosen in `getHermesClient(db)` behind an explicit, reversible setting (`meta.hermes_production_transport`, default `'acp'`). Flipping to serve is **eligibility-gated** (runtime healthy + Hermes-shaped `/api/status` + token configured); ACP rollback is always allowed. **No silent fallback** — if serve is selected and fails, the call surfaces `hermes_unavailable`; it never quietly reverts to ACP. Default stays ACP; serve is not the default for anyone.
- **Reason:** H0–H2 de-risked the transport; live H3 validation proved the production path works and fixes the ACP failure mode. The user explicitly wants serve *selectable*, not the global default, until it is proven on real workflows.
- **Session/isolation:** ONE fresh Hermes serve session per `chat()` (each workflow Agent-node run) — workflow nodes never inherit unrelated conversational context. Hermes' own memory is still machine-persistent (H0); a dedicated IGRIS profile / `--isolated` is the future privacy lever (H4) — documented, not yet built.
- **Concurrency:** the live experiment showed serve sessions run **independently** (a short session finished before a concurrent slow one), so IGRIS uses **bounded concurrency** (a process-wide semaphore, default 3) with backpressure — not ACP's global serial queue (which ACP keeps).
- **Liveness:** per-request liveness = streaming-event activity (inactivity timeout) + the independent `GET /api/status` health channel — NOT `gateway_busy` or `serve --status`. Layered timeouts (connect/request/inactivity). On timeout: `session.interrupt` then fail truthfully; never restart Hermes merely because a task exceeded budget. Approval events (`approval.request`/`sudo.request`/`secret.request`) are detected and fail with `hermes_approval_required` — never auto-answered (Phase E owns them).
- **Consequences / open (GO WITH CONDITIONS):** MCP-specific execution over serve was NOT isolated (server-side tools DID run live, incl. real email) → MCP marked partial/unverified; skills not triggered → unverified; the persistent-memory product decision (dedicated profile) is pending. These remain conditions before making serve a default. Capabilities keep MCP/skills `'unknown'`.
- **Phase:** HRA-2 H3.

### D20 — Human Approval as a durable pause/resume gate, separate from Decision (Phase E)
- **Decision:** a **Human Approval** node pauses a run **durably** (persist a `pending` `flow_approvals` row + set the run `waiting_approval`) and returns from the engine; a human resolves it via the approval API and `resumeWorkflowRun(runId)` reloads the **immutable** version, rebuilds scheduler state from the persisted node runs, and continues. It is a distinct node type from **Decision** — Decision is machine logic (deterministic, evaluates conditions), Approval is a human gate. They are never merged.
- **Routing:** Approval routes exactly like Decision — the resolved node sets `output.data.selectedRoute` to the approve/reject route label and `isEdgeActive` activates only the matching `sourceHandle` edge. A **rejection is a normal outcome** down the reject branch, not a `failed` run; the node run gets a distinct `rejected` status (never `failed`, which is reserved for execution errors). The run finishes `success` unless a real error occurs.
- **No upstream rerun:** resume seeds `state`/`status` from persisted node runs, so a succeeded Agent/tool node is **never re-executed** (proven by an executor call-count test: exactly 1 before and after approval). Runs execute the immutable published version; drafts are never resumed.
- **Idempotency + lock:** resolution is a conditional `UPDATE … WHERE status='pending'` (SQLite `changes===1`) so approving twice resolves once and resumes once; only the winning call triggers `resumeRunBg`, and the process-wide active set (INC-001, `globalThis`) is the resume lock. The reconciler only touches `running` runs, so a `waiting_approval` run **survives restart** and is never marked `interrupted`.
- **Security:** the approve/reject endpoints are backend-authoritative — the client sends only the approval id + decision + optional note; the run/workflow/routes come from the persisted row, so one approval can never resolve a different run. `context_json` holds non-secret workflow data only. Nothing auto-approves — not native Approval nodes, not Hermes `approval/sudo/secret.request` events.
- **Hermes boundary (PARTIAL):** native Approval nodes are fully implemented. Resuming a Hermes **session** mid-turn after a human decision is **deferred** — the verified `serve` protocol exposes no approve/reject continuation RPC. Hermes-originated requests surface as `hermes_approval_required` and stop there; use a Human Approval node for a durable gate.
- **Deferred:** approval expiry/TTL (the `expired` status is defined but never produced) and an auth layer (resolver actor is hard-coded `local_operator`) are not built.
- **Phase:** E.

### D21 — Workflow delete is guarded delete-or-archive (history-safe), and node delete is draft-only
- **Decision:** deleting a workflow is **backend-authoritative** and history-aware. The `flow_*` tables have **no FK constraints**, so the old `flowWorkflows.remove()` destroyed immutable `flow_versions` and orphaned `flow_runs`/`flow_node_runs`/`flow_approvals`. New policy (service `lib/flows/workflow-admin.ts` → `removeOrArchiveWorkflow`): if the workflow has **any** published version or run (`flowWorkflows.hasHistory`), it is **soft-archived** (`flow_workflows.archived_at`, hidden from the active list) so all audit/immutable records survive; only a **history-free draft** is hard-deleted. The API returns which path happened (`mode: 'deleted' | 'archived'`) so the UI explains it; a missing workflow is `404`. Node deletion on the canvas edits the **draft only** — it removes the node and every connected edge (pure `lib/flows/graph-ops.ts`), and an already-published immutable version is never mutated until the user Publishes again.
- **Reason:** the user hit two real gaps (couldn't delete a workflow, couldn't delete a node). Cascade-deleting production/audit data on a demo-turned-real product is unacceptable; archiving is the history-safe default that still gives the user a working "remove". Keeping node deletion draft-scoped preserves the Phase-A immutable-version guarantee.
- **Consequences / guards:** additive, idempotent migration `migrateFlowWorkflowsTable` adds `archived_at TEXT` (fresh DBs get it in `CREATE TABLE`; existing DBs via `ALTER TABLE`). `flowWorkflows.all()` excludes archived by default (`{ includeArchived: true }` to include). Rename (`PATCH /api/flows/:id`) trims + rejects whitespace-only names; **duplicate names are allowed** (the workflow `id` is the identity, not the name). Node-delete keyboard path is guarded (`shouldDeleteSelection` + `isEditableTarget`) so Backspace while typing edits text, not the graph; React Flow's built-in `deleteKeyCode` is disabled in favor of this deterministic, unit-tested path. Every node type gains an optional `description` (additive to `nodeBase`). **Legacy `agent_flows` is never touched.** No Phase-E approval logic changed.
- **Phase:** UX fix (post-E). Phase F not started.
