# SECURITY

> The security model for credentials and destructive actions. These rules are
> load-bearing — several are enforced by tests.

## Where secrets live

- **API keys / provider credentials** live only in **`.env.local`** (gitignored) and, at runtime, in the user's canonical cred files resolved by `lib/creds.ts`. They are **never** committed, and **never** copied into the repo.
- Credential resolution: `runtimeEnv()` = `process.env` + `readEnvLocal()`; `resolveCred(name, files)` reads `.env.local` first, then canonical files. `keyFor(provider)` (`lib/models/resolve.ts`) reads the provider's `envKey`.
- The Hermes brain is configured by `LLM_PROVIDER` (+ `HERMES_*` env). Provider keys use `<PROVIDER>_API_KEY` names from the catalog.

## What the database stores

- `model_provider_connections` stores **metadata + health only**: enabled flag, base URL, last-check/last-success timestamps, last error. **There is no secret column.** `has_credential` is derived from the env at read time.
- No table stores API keys, tokens, or Authorization headers.

## Frontend boundary

- The frontend only ever learns **`hasCredential: true/false`** — never the value.
- `GET /api/models` returns provider status/models but no secret (tested: the raw key string appears nowhere in the response; provider objects have no `apiKey`/`key` field).
- Run/node-run responses expose provider/model **identifiers** only — never credentials.

## Redaction

- Adapter/HTTP errors are normalized before they surface: `lib/models/router.ts normalizeAdapterError` maps to distinct codes; `lib/flows/errors.ts redactSecret` strips `Bearer …`, `sk-…`, `nvapi-…`, `AIza…` patterns and truncates before persisting to `flow_node_runs.error_message`.
- Never log API keys, Authorization headers, raw secrets, or env contents.

## Credential update behavior

- Connecting a provider with a **blank** API key must **not** erase an existing stored key (tested in `models-api.test.ts`). Only an explicit key value overwrites; only `DELETE` removes it.
- Base URLs are not secrets but must be validated (`http(s)://`).

## Destructive / external actions

- The Conductor's operator actions (create/edit/delete/run agent) are **confirm-each** — the UI confirms before the write endpoint is called.
- The workflow engine's executors are **read/compute-oriented** in Phase C: Input/Agent/Output. Do **not** add unattended destructive external side effects (send email, submit, delete, spend) to executors — those should pass a **Human Approval** node (Phase E — now available) before the side effect runs. (Wiring executors to require an upstream approval is a Phase-E follow-on, not yet built.)

## Commander DO lane — action registry (UX Foundation U3)

- **The registry is a security boundary.** `lib/commander-actions.ts` is the only path from a Commander DO utterance to a mutation. It exposes a **closed, typed allow-list** (`run_workflow`, `publish_workflow`, `delete_workflow`, `resolve_approval`, `set_hermes_transport`). The LLM/Conductor may only *select* a registered type — it can never supply an endpoint, method, body, URL, SQL, or shell. `executePlan`/`previewPlan` derive the exact existing route from the typed action alone, and every id is URL-encoded (a crafted id cannot escape its route). Unknown action ids are rejected (`isCommanderActionType`).
- **No side effect bypasses Preview.** Recognition never executes; it returns data only. A confirm executes only from a non-blocked `preview` state, and only on an **explicit** `Ctrl/Cmd+Enter`/Confirm — plain Enter merely builds the (GET-only) preview. GO and ASK can never execute a mutation, and ASK never runs a Conductor-proposed action.
- **Previews are authoritative and secret-free.** Cards are built from live backend reads, not raw text, and carry identifiers + safe status only — never tokens, prompts, graphs, or the approval `context_json` blob. Risk is **raised, never under-claimed** when downstream effects are unknown (delete/approve = high). Blockers (never-published, invalid draft, already-resolved approval, serve-ineligible) **disable Confirm** before any call is made.
- **Reuse, not duplication; no generic executor.** Confirmed actions call the existing Phase C/E/HRA-2 endpoints; the Commander adds **no** generic "execute" endpoint and duplicates no business logic, so all the backend-authoritative guarantees below (approval ownership/idempotency, delete-vs-archive, serve eligibility) still hold. A frontend double-submit guard disables Confirm while executing, but the backend remains the idempotency authority. **Human Approval is never auto-approved** — `approve this` previews then calls the same `POST …/approve|reject` route.

## Executive Manager authority (Architecture V2 · F1)

- **Planning grants no authority; the server owns safety.** The LLM proposes a mission plan but the server validates it (Zod `MissionPlanSchema`), **generates task ids itself** (never trusts LLM-supplied ids), validates capability ids (F0.1) + dependencies (F0.2), and fails safely on a bad plan. Planning creates/updates tasks only — it starts no execution.
- **Closed operation set; no generic executor.** The Manager exposes only typed operations (plan / manager-step / dispatch / report), each behind a narrow Zod route — there is **no** `execute-anything` endpoint and no arbitrary URL/SQL/shell/tool path. Dispatch delegates through the EXISTING agent runtime and the EXISTING Workflow Engine; it duplicates no run logic.
- **Capabilities are not permissions.** A capability match makes a task *dispatchable*, never *authorized*. Workflow dispatch runs the **immutable published version only** (never a draft) and preserves Phase-E Human Approval; a paused run surfaces the task as `waiting_approval` + an `APPROVAL_REQUIRED` event, and the operator resolves it on `/approvals` — **the Manager creates no `company_approvals` and holds no approval authority**.
- **No privilege expansion / no agent creation.** A task with no eligible agent yields a structured `CAPABILITY_GAP` and stays queued — **F1 never creates an agent, grants tools, copies an agent, or edits the org** (that is the F2 Agent Factory, which will itself be policy- and approval-gated).
- **Bounded, durable, idempotent.** `managerStep` runs one bounded tick (no autonomous/infinite loop). A running/terminal task is never re-dispatched; the workflow `runId` is never overloaded with an agent-run id (`executionKind`/`executionRefId` are explicit). The event ledger is append-only, emitted only after canonical state persists, best-effort (a ledger failure never corrupts state), and carries bounded/safe metadata only — never prompts, secrets, tool args, or raw approval context. Report/feed projections expose safe artifact metadata only, never artifact `content`.

## Human Approval endpoints (Phase E)

- **Backend-authoritative:** `POST /api/flow-approvals/:id/approve|reject` accept only the approval id (path), the decision (route), and an optional note. The run id, workflow, node, and approve/reject routes are read from the persisted `flow_approvals` row — the client cannot supply run state, a workflow id, or a foreign run. One approval can therefore only ever resolve its own run.
- **Nothing auto-approves.** Only a human, via these endpoints, resolves a Human Approval node or a Hermes `approval/sudo/secret.request`. Resolution is idempotent (a conditional `UPDATE … WHERE status='pending'`), so a double-submit or race resolves once and resumes once.
- **No secrets in `context_json`.** The approver context holds non-secret workflow data only (the resolved node input text + configured references) — never credentials, tokens, or a `secret.request` value. The approvals list/inspector return the row as-is precisely because it carries no secret.
- **Runs execute immutable versions.** Resume reloads the published version and continues from persisted node runs; a paused run's graph cannot be mutated out from under it, and succeeded nodes are never re-run.

## Workflow delete / archive (history-safe)

- **The backend decides delete vs archive, not the client.** `DELETE /api/flows/:id` calls `removeOrArchiveWorkflow` (`lib/flows/workflow-admin.ts`): a workflow with any published version or run is **soft-archived** (`archived_at`) so immutable versions and run/approval audit records are **never destroyed**; only a history-free draft is hard-deleted. The response states which happened; a missing id is `404`.
- **No cross-workflow / injection reach.** All repo queries are parameterized; a bogus or injection-shaped id resolves to `not_found`, never touches another workflow, and never executes SQL. The service touches only the `flow_*` tables — the legacy `agent_flows` system is never affected.
- **Rename is validated.** `PATCH /api/flows/:id` trims the name and rejects whitespace-only (`400`); duplicate names are allowed because the workflow `id`, not the name, is the identity.
- **Node deletion is draft-only.** Deleting a canvas node edits the draft; an already-published immutable version is unchanged until the user Publishes again.

## Security checklist for AI coding agents

Before modifying any model/provider/credential code, confirm:

- [ ] No secret is **persisted** to any DB table.
- [ ] No secret appears in any **API response**.
- [ ] No secret is **logged**.
- [ ] Errors are **redacted** before storage/surfacing.
- [ ] **Blank credential** on update does not reveal or erase a stored key.
- [ ] The frontend receives only `hasCredential` (boolean), never the value.
- [ ] Base URLs are validated; no `javascript:`/non-http schemes.
- [ ] A secret-leak test exists for any new route touching credentials.

## Hermes runtime management (HRA-2 H2)

- **Serve token stays backend-only.** The Hermes `serve` dashboard token lives only in
  `.env.local` (`HERMES_SERVE_TOKEN`, file mode 0600) — never in SQLite, never returned to the
  frontend, never logged. The API/UI expose `tokenConfigured` (boolean) only. Managed start passes
  the token to serve via the `HERMES_DASHBOARD_SESSION_TOKEN` **environment variable**, never on the
  command line.
- **Ownership before action.** A process is `managed` only if IGRIS launched it and its PID is still
  alive; anything else reachable on the port is `external`/shared. Stop kills the **exact owned PID**
  only — never `hermes serve --stop` (which stops all servers) and never an external/shared runtime.
- **No blind trust of a port.** A candidate binary is accepted only if `<bin> --version` prints a
  Hermes banner; a reachable endpoint is treated as Hermes only if `/api/status` is Hermes-shaped
  (version + components/gateway fields). A bare HTTP 200 is not Hermes.
- **Command execution.** Discovery/lifecycle use `execFile`/`spawn` with argv arrays and no shell
  (`shell:false`), bounded timeouts, and redacted errors — no string-interpolated shell commands.

## Serve production transport (HRA-2 H3)

- **No silent fallback.** When the production transport is `serve` and serve fails, the call surfaces
  `hermes_unavailable` — it never quietly reverts to ACP (or any other model). ACP is rollback via the
  explicit `set_transport` setting only.
- **Token never leaves the backend.** The serve WS uses `HERMES_SERVE_TOKEN` from `.env.local`; it is
  never sent to the frontend, never stored in SQLite, and every serve error message is token-redacted
  (`redactToken`). Prompts are not logged by default; serve diagnostics (behind `HERMES_SERVE_DEBUG`)
  carry only safe metadata (session id, timings, event type) — never token/prompt/tool args.
- **Eligibility gate + isolation.** Serve becomes the production transport only when the runtime is
  healthy, `/api/status` is Hermes-shaped, and a token is configured. Each agent-node run opens ONE
  fresh serve session (no conversational-context bleed between unrelated runs).
- **Approval events are not auto-answered.** `approval.request`/`sudo.request`/`secret.request` from a
  serve-backed agent fail as `hermes_approval_required` — IGRIS never auto-approves a privileged action.
  Phase E ships native Human Approval NODES (durable pause/resume); resuming a Hermes SESSION mid-turn
  after a decision is deferred (no verified serve continuation RPC), so a Hermes-originated request
  surfaces honestly and stops there.
- **Persistent memory boundary.** Hermes retains its own cross-session memory independent of IGRIS
  G-Brain; per-run session isolation prevents context bleed, but sensitive workflow content may still
  enter Hermes's machine-wide memory. A dedicated Hermes profile / `--isolated` is the pending privacy
  lever (H4) and a condition before serve could become a default.
