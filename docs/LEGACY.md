# LEGACY — backward-compatibility surface

> These parts exist **only** for backward compatibility. New features must not
> depend on them. Do not delete them without a migration plan and explicit
> approval.

## The legacy Agent Flow (superseded by `/flows`)

Before the `/flows` orchestrator (Phases A–C), a single "Agent Flow" canvas
lived on `/brain`. It is now superseded but retained.

| Item | Path | Status |
|---|---|---|
| Legacy canvas component | `components/AgentFlowCanvas.tsx` | LEGACY — no longer rendered anywhere (allowlisted in `tests/orphans.test.ts`) |
| Legacy persistence table | `agent_flows` (single `main` row) | LEGACY — kept, never deleted |
| Legacy API | `app/api/agent-flows/route.ts`, `app/api/agent-flows/run/route.ts` | LEGACY — still operational |
| Legacy execution engine | `lib/agents/flow-run.ts` (text-concat chain, auto-saves to G-Brain) | LEGACY — **do not use for new `/flows` work** |

### Why it still exists
- The Phase B/C contract kept legacy operational "until `/flows` reaches full parity." `/flows` now executes (Phase C) but legacy has not been formally retired.
- The one-time migration imports `agent_flows.main` into `flow_workflows`/`flow_versions` as `wf-main` (idempotent, keyed on `wf-main`; the source is never deleted). See `flowMaintenance.importMainFlow()` in `lib/db.ts` and `tests/flows-migration.test.ts`.

### What must NOT depend on it going forward
- New workflow features use the **new** engine (`lib/flows/engine.ts`), executors (`lib/flows/executors/*`), and `flow_*` tables — never `lib/agents/flow-run.ts` or `agent_flows`.
- The legacy engine's behavior of **auto-writing outputs to G-Brain** is explicitly NOT reproduced in the new engine (memory is Phase F, explicit only). Do not copy that behavior.

### When it may be retired
Once the product owner confirms `/flows` parity is sufficient, retirement is a
separate, explicit task: remove the component + API + engine, keep or archive the
`agent_flows` table (data), remove the allowlist entry in `orphans.test.ts`, and
record it in `CHANGELOG.md` / `docs/CHANGE-LOG.md` / `docs/DECISIONS.md`. Do not
do this casually.

## Name-clash note (not legacy, but a trap)

The seeded `workflows` table and `/workflows` page are the **business
"Workflows" view**, unrelated to the orchestrator. The orchestrator uses the
`flow_*` table prefix specifically to avoid colliding with it. Do not conflate
them.
