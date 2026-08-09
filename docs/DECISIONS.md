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
