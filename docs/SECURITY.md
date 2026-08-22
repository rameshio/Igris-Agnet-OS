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

## Agent Factory authority (Architecture V2 · F2)

- **No agent is ever created silently.** A factory agent is created ONLY by `promoteProposal` on an explicit human approval (`POST /api/agent-proposals/:id/approve`) — never during planning, dispatch, or `managerStep`. Proposals are operator-triggered (`POST /api/company-tasks/:id/propose-agent`); there is **no auto-propose and no autonomous loop**. Until approval the proposal is inert: no agent row, no capability assignment.
- **The server owns the policy; the LLM only proposes.** The proposer returns a spec, but the server validates it against a `FactoryPolicy` and **fails safe** (400, nothing persisted) on any violation: tools must be on the connector-backed allow-list and bounded in count, the model must be allow-listed (or the '' default), instructions are length-bounded, and creation depth ≤ `maxDepth`. Factory agents carry `canSpawn=false` — a created agent can never itself run the factory.
- **The grant equals the gap — never more.** Promotion assigns EXACTLY the task's required (missing) capabilities, ignoring whatever capabilities the LLM listed. A capability makes an agent *dispatchable*, never *authorized* — the same F0.1/Phase-E boundary as F1. The factory grants no tools beyond the validated allow-listed set and never edits existing agents or the org.
- **Human-gated promotion reuses the Phase-E pattern, not its table.** Promotion/rejection are idempotent conditional transitions of a `pending` proposal (`WHERE status='pending'`), so a double-approve promotes exactly once. This mirrors `resolveApproval` but adds **no second approval authority** and does **not** touch `flow_approvals` (there is no run to resume).
- **Temporary + mission-bound.** Factory agents are marked temporary and retired (disabled + capabilities removed — reversible, not deleted) when their mission reaches a terminal state. All factory metadata (policy snapshot, mission, budget) lives on the proposal row; the `custom_agents` schema is unchanged. Budget is recorded and surfaced as a constraint but is not yet hard-metered at runtime (documented seam over agent_runs `cost_usd`).

## G-Brain Core / memory authority (Architecture V2 · F3)

- **Durable knowledge is EXPLICIT only.** Nothing auto-writes to canonical G-Brain — not LLM output, not artifacts, not task results, not chat, not company events. Persistence happens solely through an explicit operator/API action (save knowledge, create source/entity/relationship, or promote an artifact). There is **no autonomous memory accumulation**.
- **No agent write path to canonical G-Brain.** The G-Brain Core write APIs are operator-facing; agents cannot call them. The pre-existing `saveToGBrain` agent tool writes the SEPARATE external markdown brain-store (`lib/brain-dump.ts`), which is a different system and is left unchanged — an agent writing there never touches canonical G-Brain knowledge.
- **References, not copies; no privilege leakage.** A brain entity/source stores a `canonical_key` + safe name/summary only. It never copies an agent's tools/model/status/permissions, an approval's context, a workflow's secrets, or a raw artifact body into a second store. Safe list/feed projections expose id/type/name/summary/ref only; knowledge list reads omit full `content` (a single detail read returns it). Sources never store credentials/auth — a plain resource URL only (a `url` source's uri is validated http(s)).
- **Promotion is explicit, idempotent, and non-destructive.** `POST /api/company-artifacts/:id/promote-to-brain` is the one artifact→knowledge seam: it creates a provenance source + knowledge + canonical-ref links, is idempotent (one promotion per artifact), **never modifies the artifact** (canonical in Company Core), and **never auto-ingests** any other artifact. Provenance is answerable by canonical reference: Knowledge ← Artifact ← Agent ← Task ← Mission.
- **Confidence is never fabricated** (nullable); knowledge uses an `active`/`archived` lifecycle rather than hard deletion. **Hermes/runtime memory ≠ G-Brain** — they are separate layers and are not merged. Company events remain the operational/audit ledger, referenced only if explicitly promoted later.

## G-Brain Radial + Universal Inspector authority (Architecture V2 · F4)

- **Radial is a projection — read-only, bounded, never persisting.** `GET /api/brain/radial` and `GET /api/brain/inspect` only READ/RESOLVE canonical systems. A projection node is not a persisted `BrainEntity` and a projected edge is not a persisted `BrainRelationship`; projected relations (e.g. Mission HAS_TASK Task) are computed live and are **never written to `brain_relationships`**. **Viewing a canonical object never creates a BrainEntity** (a regression test asserts entity/relationship counts are unchanged after browsing). The graph is bounded (depth ≤ 2, ≤ 100 nodes / 200 edges) — there is no "load the whole company graph" endpoint.
- **Deep-links cannot become queries.** `parseEntityRef` accepts only a typed `kind:id` (closed kind set) or a `bent-*`/`bkno-*`/`bsrc-*` brain id, and rejects everything else — a `/brain?entity=…` parameter can never reach the DB as an arbitrary query.
- **The Universal Inspector exposes safe fields only.** Per kind it resolves identifiers + safe labels + status — **never a system prompt, model id, tool credential, workflow graph secret, or approval `context_json`** (the approval view surfaces status only). Knowledge/artifact list views omit full content.
- **The Inspector is a control surface, not authority.** Its actions are a CLOSED, typed set. Every privileged/execution/destructive action (approve/reject, dispatch, run workflow, manager-step, retire agent) is a `navigate` deep-link to the owning surface (`/missions`, `/approvals`, `/flows`), where the existing **U3 Plan→Preview→Execute / Phase-E** confirm already lives — the Inspector never invokes them directly and adds no second confirmation system. The only inline `api` actions are the safe **Promote Artifact** (F3, idempotent) and **Archive Knowledge** (reversible `active`→`archived`), each behind a confirm. The Inspector cannot bypass Phase E or Factory policy, grant permissions, mutate SQLite directly, run tools, or auto-start agents.
- **No live-event coupling.** F4 does not pipe `company_events` into the brain view (that is F5); the Neural tab is an inert placeholder.

## G-Brain Neural authority + privacy (Architecture V2 · F5)

- **Neural is a read-only projection, not a runtime or a second event store.** `GET /api/brain/neural` only READS the authoritative sources — it never orchestrates, dispatches, mutates canonical state, replaces `company_events`/flow-runs/agent-runs/Phase E, or persists anything. A regression test asserts `company_events` and `brain_*` row counts are unchanged after projecting. There is no mutation endpoint and no autonomous or graph-controlled action.
- **Ledger for history, canonical state for status.** `company_events` supplies the historical edge + timestamp; the CURRENT status of every node comes from live canonical state (`task.status`/`mission.status`/`flow_run.status`/`approval.status`/presence) and is never reconstructed from stale event replay — Neural cannot present a stale event as current truth.
- **Bounded.** Default 60-minute window (15m/1h/6h/24h) with hard caps (≤ 250 events / 150 nodes / 300 edges) and a `truncated` flag — no "load all company history"; `parseEntityRef` (reused from F4) rejects malformed roots so a URL parameter can never become an arbitrary query.
- **Safe projection only.** Nodes/edges carry identifiers + labels + coarse status + short safe summaries. They NEVER expose prompts, system instructions, auth tokens, tool credentials, approval `context_json`, workflow `startingInput`, node outputs, tool args, or email/task input blobs. The Inspector's `workflow_run` kind shows workflow/version/status/started only; the `event` kind shows type/time/summary/refs only — verified by leak-canary tests.
- **No new realtime infrastructure.** Liveness is polling (~5s) with a no-overlap guard, paused unless the Neural tab is active and stopped on unmount — **no WebSockets**. Failure is honest (retry state; "as of {generatedAt}"), never presenting stale data as live.
- **Boundaries preserved.** Radial is unchanged (no `company_events` projected into it); Neural writes nothing to G-Brain knowledge (no `event → BrainKnowledge`).

## Company Intelligence authority + privacy (Architecture V2 · F6)

- **Derived read model, never authority.** `GET /api/company/intelligence` only READS existing canonical state (missions/tasks/agents/capabilities/runs/approvals/events/proposals) and derives counts, timings, coverage, and signals. It never mutates a canonical table, never creates an agent (Factory F2 stays the sole creation authority), never reassigns or auto-remediates, and adds **no new event/telemetry/analytics store** (one company-wide read method only). A regression test asserts `company_tasks`/`company_missions`/`company_events`/`company_agent_proposals`/`brain_entities` row counts are unchanged after generating a snapshot. There is no mutation endpoint.
- **Navigation only.** The dashboard exposes deep-links to the owning canonical surfaces (Missions / G-Brain `?entity=` / Agents / Flows / Approvals) — it renders no action controls. Any future mutating action must go through the existing U3/Phase-E authority path, never from Intelligence. It writes nothing to G-Brain knowledge (**no `signal → BrainKnowledge`** ingestion).
- **No fake precision.** Metrics the underlying data cannot defensibly support are `null` (insufficient_data), never manufactured — there is deliberately no cost/token/utilization/quality metric (no telemetry backs them) and no performance/"best-employee" score. Signals are a CLOSED, deterministic set of 8 types (never LLM-generated), each carrying evidence + the firing threshold.
- **Safe projection only.** The snapshot carries identifiers + labels + counts + timings. It NEVER exposes prompts, system instructions, model ids, auth tokens, tool credentials, approval `context_json`, workflow `startingInput`, node outputs, tool args, or artifact content — verified by leak-canary tests scanning the serialized snapshot.
- **Bounded input.** The window is validated against a closed set (1h/24h/7d/30d, default 7d); an unknown value is rejected with 400 — a URL parameter can never widen the analysis arbitrarily.

## G-Brain consolidation + mission cleanup safety (Architecture V2 · consolidation)

- **The consolidated brain is a projection, never persistence.** `GET /api/brain/company-graph` READS canonical systems and projects them into the renderer's graph model; it writes nothing. A visualization node is NOT a persisted `BrainEntity` and a visualization edge is NOT a persisted `BrainRelationship` — missions/tasks/agents appear dynamically without being written to `brain_entities`, and drawing them NEVER ingests into durable G-Brain knowledge (artifact→knowledge promotion stays the only explicit, human-triggered ingestion). Entity refs are parsed with the strict F4 `parseEntityRef` (an invalid `?entity=` → 400 — a URL parameter can never become an arbitrary query).
- **Safe projection.** The graph carries safe identifiers + labels only (mission/task/agent/artifact titles, statuses). It never exposes prompts, model ids, tool credentials, approval `context_json`, workflow `startingInput`, node outputs, or artifact content — verified by leak-canary tests scanning the serialized graph.
- **Cleanup is scoped, previewed, and confirm-gated — never a global wipe.** There is deliberately no `DELETE FROM everything` / generic reset. `archiveMission` is a lifecycle-safe DIRECT status write (`archived`, hidden-from-default) that keeps every owned record. `deleteTestMission` requires an explicit `{confirm:true}` (a delete without it → 400), is preceded by a read-only preview of exactly what will be removed vs preserved, is server-authoritative (ownership resolved from the mission's own rows), and cascades ONLY mission-OWNED records (tasks/dependencies/artifacts/events/proposals). Temporary mission-bound factory agents are RETIRED (disabled + unassigned), never hard-deleted. **Shared agents, reusable workflows, and durable promoted G-Brain knowledge are never touched by a mission delete** — a test mission going away must not destroy state that outlived it. No cascade ever reaches into shared canonical objects.

## Capability vs Tool authority (Architecture V2 · tool-backed eligibility)

- **A capability label is not an authority to use a tool.** A capability says what an agent CAN do; a TOOL is the concrete, connector-backed mechanism. Eligibility for a tool-backed capability requires BOTH — the label AND a required, WIRED tool actually assigned to the agent. Tool availability is canonical (assigned slug ∈ the wired `agent-tools` registry); it is NEVER inferred from an agent's instructions, description, or name. This prevents an agent from being treated as web-capable just because its prompt claims it can research.
- **The Factory cannot manufacture tool access.** A proposed agent may carry only allow-listed, connector-backed tools; a spec whose tool-backed capability cannot be satisfied by a grantable tool fails policy (propose 400, and a defensive re-check at promotion) — so the factory never creates a capability-label-only agent, never auto-grants an unauthorized tool, and never invents a connector. Human approval stays authoritative; approval of an unsatisfiable proposal is impossible because it never validates.
- **Dispatch preflight is the last line of defence.** Immediately before execution the manager re-verifies the chosen agent (including a directly-assigned one) actually has the required, wired tools. A tool gap fails BEFORE the agent starts — no `AGENT_STARTED`, no `agent_runs` row, no LLM run spent pretending to perform the task — and the task stays queued with an explicit `tool_gap` reason.
- **Safe reasons only.** The eligible-agents API and `/missions` surface a plain tool-gap reason (capability id + required tool ids). They never expose connector configuration, credentials, or `.env` values.
- **The real web/search tool is search-only (no SSRF surface).** `research.web` is now backed by a live tool, `web.search` (Tavily, `lib/connectors/websearch.ts`). It performs **search only** — it returns a bounded list of public results (title/url/snippet/source) and does NOT fetch arbitrary URLs, so there is no server-side request-forgery surface in this pass. If a `fetchWebPage` capability is ever added, it MUST first enforce a full SSRF blocklist (localhost, `127.0.0.0/8`, `::1`, RFC1918/private ranges, link-local, cloud metadata endpoints, `file://`/`ftp://` and any non-http(s) scheme), revalidate redirects, and cap timeout/response-size/redirects — search-only sidesteps all of that.
- **Honest failure, real credential handling.** No `TAVILY_API_KEY` ⇒ the tool fails with setup guidance and makes NO network call; a provider error, timeout, or rate limit surfaces the real error — the agent never silently falls back to unsourced model knowledge while claiming current web research. The key is resolved from env (`.env.local`/process env) at call time and is never copied into the repo; the connector returns only `{title,url,snippet,source}` (no raw HTML, headers, cookies, or the key). The Factory may grant `web.search` because it is allow-listed and connector-backed, but granting it is still bounded, human-approved, and never automatic.

## IGRIS CLI + model control plane (control surface, not authority)

- **The CLI never touches SQLite or a secret.** `igris` speaks only to the canonical HTTP API, so all validation, permission, and state authority stay server-side. It never opens the database and never imports a service; a mutation goes through the same endpoint the UI uses.
- **Approvals stay authoritative.** Every CLI mutation previews then requires confirmation; `--yes` skips only the local prompt and CANNOT bypass Phase-E — workflow runs still pause at approval nodes, and `approval approve|reject` routes through the backend-authoritative `/api/flow-approvals/:id/…` endpoints. A non-interactive session without `--yes` refuses the mutation (exit 4) rather than acting silently.
- **Provider keys never leave the server.** `GET /api/models/providers` returns configured/connected state and capabilities only — never an API key. Keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `AI_GATEWAY_API_KEY`, `TAVILY_API_KEY`, …) live in `.env.local` (backend-only). The CLI never sends, stores, or prints a key, applies a defensive secret-redaction pass to ALL output, and reads only non-secret values from `~/.igris/config.json` (credential-looking fields are dropped).
- **One runtime, no silent fallback.** All LLM calls flow through `routeModel` (`lib/models/*`); a configured model that fails returns an explicit `ModelRouteError` (`auth_failed`/`hermes_unavailable`/`model_capability_mismatch`/…) — the system never quietly retries on a different provider or fabricates an answer. `ask` is read-only and grounded in a safe company summary (no approval `context_json`, no secrets).
- **A deleted canonical object is never reconstructed or substituted.** When a Company Artifact has been deleted (mission cleanup) but its promoted G-Brain provenance survives, the Universal Inspector shows an honest `source_deleted` view — the preserved provenance edges and knowledge titles only. It NEVER resurfaces the deleted artifact's content, never fabricates the artifact, and never substitutes promoted BrainKnowledge content for it (canonical ownership stays distinct). `igris artifact show <deleted-id>` fails clearly rather than returning knowledge content. A truly-unknown id remains a real 404.

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
