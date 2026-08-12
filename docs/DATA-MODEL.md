# DATA-MODEL

> All persistence is **SQLite** via `better-sqlite3` at `data/founder-os.db` (WAL,
> auto-seeded on first touch). Schema + repositories live in `lib/db.ts`; Zod
> schemas validate rows on the way out (`lib/schemas.ts`, `lib/flows/*.ts`,
> `lib/models/types.ts`). **Never query SQLite from a page/route — use a repo.**
>
> Migrations: tables via `CREATE TABLE IF NOT EXISTS`; column adds via guarded
> `ALTER TABLE` (checked with `pragma table_info`). All additive, idempotent,
> non-destructive (see `RELEASE-PROCESS.md § Migrations`).

## Definition vs Version vs Run vs NodeRun (the core relationship)

```
flow_workflows (identity + metadata + EDITABLE draft_graph + current_version pointer)
      │  publish
      ▼
flow_versions (IMMUTABLE graph snapshot; UNIQUE(workflow_id, version))
      │  run
      ▼
flow_runs (one execution of one immutable version; status, tokens, timing)
      │
      ▼
flow_node_runs (per-node execution record: input/output JSON, model metadata, timing, error)
```

- A **draft** (`flow_workflows.draft_graph`) is edited freely (Save).
- **Publish** freezes the draft into a new immutable `flow_versions` row.
- A **run** references a specific immutable version forever; later draft edits never change it.
- **Runtime status is never written back into the graph JSON** — it lives only in `flow_runs` / `flow_node_runs`.

## Tables

Legend: **Mut** = mutable / **Imm** = immutable rows.

### Agents & runtime

| Table | Purpose | PK | Key columns | Mut | Phase |
|---|---|---|---|---|---|
| `custom_agents` | Client-authored agents (data-driven) | `id` | name, description, department_id, instructions, **model**, tools(JSON), enabled, timestamps | Mut | pre-A |
| `agents` · `departments` · `tools` | Built-in roster + org scaffolding (seeded) | `id` | — | Mut | pre-A |
| `agent_runs` | Per-agent `run()` results | `id` | agent_id, ok, summary, model, tokens_in/out, cost_usd, timestamps | append | pre-A |
| `agent_messages` | Per-agent **interactive chat** history | `id` | agent_id, role, content, tool_calls(JSON), created_at | append | pre-A |

> Note the `model` column on `custom_agents` encodes the agent's model strategy:
> `''`→hermes, `'auto'`→auto, `'providerId:modelId'`→fixed (see `lib/models/settings.ts`).
> **Workflow node execution does NOT write to `agent_messages`** — it writes to `flow_node_runs`.

### Models (Phase B)

| Table | Purpose | PK | Key columns | Mut | Phase |
|---|---|---|---|---|---|
| `model_provider_connections` | **App-wide** provider config + health, **metadata only** | `provider_id` | display_name, enabled, base_url, last_check_at, last_success_at, last_error, timestamps | Mut | B |

- **No secret column.** API keys live in `.env.local`; `has_credential` is derived from the env at read time (`lib/models/connections.ts`).
- Absent row = defaults (enabled, catalog base URL, unknown status).

### Flows — definition (Phase A)

| Table | Purpose | PK | Key columns | Mut | Phase |
|---|---|---|---|---|---|
| `flow_workflows` | Workflow identity + metadata + **draft graph** | `id` | name, description, **draft_graph**(JSON), **current_version**, **archived_at**, timestamps | Mut | A |
| `flow_versions` | **Immutable** published graph snapshots | `id` | workflow_id, version, **graph**(JSON), created_at · `UNIQUE(workflow_id, version)` | **Imm** | A |

> **`archived_at`** (additive, idempotent migration): a workflow with history (any version or run) is **soft-archived** here instead of hard-deleted, preserving immutable versions + run/approval audit. `flowWorkflows.all()` hides archived rows by default. A history-free draft is still hard-deleted. See `DECISIONS.md` D21.
> **Node `description`** (additive to the graph JSON `nodeBase`): every node type carries an optional author note edited in the canvas inspector; it round-trips through draft Save and version Publish. No table change (nodes live inside `draft_graph`/`graph` JSON).

### Flows — execution (Phase C)

| Table | Purpose | PK | Key columns | Mut | Phase |
|---|---|---|---|---|---|
| `flow_runs` | One execution of one immutable version | `id` | workflow_id, **workflow_version**, status, starting_input(JSON), current_node_id, started_at, ended_at, error_code, error_message, total_tokens, estimated_cost, timestamps | Mut (status lifecycle) | C |
| `flow_node_runs` | Per-node execution record | `id` | run_id, node_id, node_type, status, **input_json**, **output_json**, provider_id, model_id, model_strategy, adapter, prompt/completion/total_tokens, estimated_cost, started_at, ended_at, duration_ms, attempt, error_code, error_message, timestamps | Mut (status lifecycle) | C |
| `flow_approvals` | A Human Approval gate (durable pause-point) | `id` | run_id, node_run_id, workflow_id, workflow_version, node_id, status, request_type, title, message, **context_json** (non-secret only), approval_route, rejection_route, requested_at, resolved_at, resolved_by, resolution_note, timestamps | Mut (status lifecycle) | E |

Indexes: `idx_flow_runs_workflow (workflow_id, created_at)`, `idx_flow_node_runs_run (run_id)`, `idx_flow_approvals_run (run_id)`, `idx_flow_approvals_status (status, created_at)`, `idx_flow_approvals_node_run (node_run_id)`.

**Run status:** `queued → running → success | failed | canceled | interrupted`, plus **`waiting_approval`** (Phase E — a run paused on a Human Approval node; durable, survives restart, resumed by `resumeWorkflowRun`).
**NodeRun status:** `queued → running → success | failed | skipped | waiting_approval | rejected` (Phase E adds `waiting_approval` for a paused gate and `rejected` for a human rejection — a normal outcome, NOT `failed`).
**Approval status:** `pending → approved | rejected | cancelled` (`expired` defined but not produced yet). Resolution is a conditional `UPDATE … WHERE status='pending'`, so approving twice resolves once.

> **Phase E** added only `flow_approvals` (+ indexes), additive/idempotent — no existing table or column
> changed, immutable versions untouched. The approval node routes like a Decision: the resolved node's
> `output_json.data.selectedRoute` is the approve/reject route, activating only the matching edge handle.
> `context_json` holds non-secret workflow data ONLY (never credentials/tokens); the resolver actor is
> `local_operator` (no auth layer yet).

> **Phase D added NO tables or columns.** Workflow logic (Decision rules + conditions, edge
> `mapping` field/template/object, edge `condition`, Transform config) lives in the **version graph
> JSON**. Runtime detail lives in existing `flow_node_runs` JSON columns: a Decision's chosen route
> and per-rule outcomes in `output_json.data.selectedRoute` / `.evaluated`; a Join's combined inputs
> in `output_json.data.branches`; a skipped node's reason in `error_code`
> (`branch_not_selected` / `upstream_skipped`) + `error_message`.

### Legacy (compat only — see `LEGACY.md`)

| Table | Purpose | Mut | Phase |
|---|---|---|---|
| `agent_flows` | The old single "main" Agent Flow canvas | Mut | pre-A |

> `agent_flows` is **kept, not deleted.** On DB open it is imported once
> (idempotently, keyed on `wf-main`) into `flow_workflows`/`flow_versions`. New
> features must build on `flow_*`, never `agent_flows`.

### Other (business/operational, seeded)

`metrics`, `roadmap_items`, `phases`, `personas`, `domains`, `skills`,
`people`, `sop_tasks`, `funnel_contacts`, `funnel_touches`, `workflows`
(the operational Workflows page — **distinct** from `flow_workflows`),
`social_*`, `broadcasts`, `agent_tasks`, `agent_crons`, `contact_tags`,
`meta` (key/value flags, e.g. `demo_cleared`). These are outside the
agents/models/flows core; touch only when working on those business pages.

> **HRA-2 H2 added NO tables/columns.** The Hermes runtime manager stores only
> **non-secret** config in the existing `meta` KV: `hermes_runtime_mode`,
> `hermes_runtime_host`, `hermes_runtime_port`, `hermes_runtime_bin`,
> `hermes_runtime_enabled`, `hermes_runtime_last_check`, `hermes_runtime_last_success`,
> `hermes_runtime_last_error`, `hermes_runtime_last_version`. The serve dashboard
> **token is NEVER in SQLite** — it lives only in `.env.local` (`HERMES_SERVE_TOKEN`);
> the app exposes `tokenConfigured` (a boolean), never the value.

> ⚠️ **Name clash to remember:** the seeded `workflows` table (business
> "Workflows" page) is **not** the orchestrator. The orchestrator uses the
> `flow_*` prefix specifically to avoid this collision.

## Repository access (examples)

```ts
const db = getDb();                         // app singleton (lib/data.ts)
db.flowWorkflows.get(id)                     // { id, name, description, draftGraph, currentVersion, ... }
db.flowVersions.get(workflowId, version)     // immutable snapshot { graph, ... }
db.flowRuns.create({ id, workflowId, workflowVersion, startingInput })
db.flowRuns.update(id, { status, endedAt, totalTokens, ... })
db.flowNodeRuns.create({ id, runId, nodeId, nodeType, status })
db.flowNodeRuns.update(id, { status, output, providerId, modelId, ... })
db.modelConnections.upsert(providerId, { enabled, baseUrl })   // metadata only
```

Adding data anywhere = **new repo method + Zod schema + (seed entry if seeded) + test**.
