# Changelog

All notable, meaningful changes to IGRIS Agent. Format based on
[Keep a Changelog](https://keepachangelog.com/). This tracks product /
architecture / runtime / DB / security changes — not formatting or trivial edits.
Deeper per-checkpoint engineering records live in `docs/CHANGE-LOG.md`;
failures/RCAs in `docs/INCIDENTS.md`.

## [Unreleased]

### Added
- **G-Brain Flow orchestrator** (`/flows`): multiple named workflows, typed nodes/edges, editable drafts, immutable published versions, validator. (Phase A)
- **Unified model runtime**: `ModelRouter` with `fixed | hermes | auto` strategies; per-agent model configuration UI; provider connect/test/enable/disable; providers Google, NVIDIA, Ollama (local), and custom OpenAI-compatible added; model badges on flow agent nodes. (Phase B)
- **Workflow execution engine + Run Inspector** (Phase C): Input/Agent/Output nodes execute in dependency order through the `ModelRouter`; persisted run + node-run history; in-process run coordinator with polling; Run Inspector panel, canvas run-status overlay, starting input, run history; Save vs Publish vs Run distinction.
- **AI-developer handoff package**: `AGENTS.md` (platform-independent) + `docs/AI-HANDOFF.md`, `PHASE-STATUS.md`, `DATA-MODEL.md`, `CODING-METHODOLOGY.md`, `TESTING-GUIDE.md`, `EXTENDING.md`, `SECURITY.md`, `LEGACY.md`, `DECISIONS.md`, `NEXT-AI-PROMPT.md`, `RELEASE-PROCESS.md`, `INCIDENTS.md`, `CHANGE-LOG.md`, and this `CHANGELOG.md`.

### Changed
- Per-agent chat now executes through the unified `ModelRouter` (previously direct/brain routing). (Phase B)
- The Agent Flow canvas was **removed from `/brain`**; `/brain` is now knowledge-only. Orchestration lives on `/flows`.
- Architecture doc (`docs/ARCHITECTURE.md`) updated through Phase C.

### Fixed
- Flow runs were falsely marked `interrupted` while still running — the in-process active-run registry was not shared across Next.js per-route bundles. Pinned it to `globalThis`. (See `docs/INCIDENTS.md` INC-001.)
- Canvas node "Delete" previously deleted the underlying agent everywhere; split into non-destructive **Remove from canvas** vs a clearly-labeled two-step **Delete agent**. (INC-004)
- Provider connection status no longer shows a false "connected" from mere key presence; a real backend check is required (`unverified`/`connected` states). (INC-003)

### Database
- Added `flow_workflows`, `flow_versions` (Phase A).
- Added `model_provider_connections` — metadata/status only, **no secret column** (Phase B).
- Added `flow_runs`, `flow_node_runs` + indexes `idx_flow_runs_workflow`, `idx_flow_node_runs_run` (Phase C).
- All additive, idempotent, non-destructive. Legacy `agent_flows` retained and imported once into `wf-main`.

### Security
- Provider API keys live only in `.env.local`; the DB stores presence/status, never the value; frontend receives `hasCredential` only.
- Provider/adapter errors are redacted before persistence/surfacing.
- Blank credential on update does not erase or reveal a stored key.

### Deprecated
- Legacy Agent Flow: `components/AgentFlowCanvas.tsx`, `app/api/agent-flows/*`, `lib/agents/flow-run.ts`, table `agent_flows` — kept operational for backward compatibility; not for new work. See `docs/LEGACY.md`.

### Known Issues
- Workflow execution is sequential; only Input/Agent/Output execute (Decision/Transform/Parallel/Join/Approval/Memory are placed-but-rejected-before-run).
- `auto` model strategy is a stub (fails `auto_not_implemented`); no fallback/retries/cancel.
- Hermes ACP reports no token usage → node token counts `null`; estimated cost `null` (no fabricated pricing).
- Stale-run detection is on read (→ `interrupted`); no background sweeper or auto-resume.
- Two seed/api render tests are intermittently flaky under full-suite parallel load (pass in isolation / on re-run).
