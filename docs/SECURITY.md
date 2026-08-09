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
- The workflow engine's executors are **read/compute-oriented** in Phase C: Input/Agent/Output. Do **not** add unattended destructive external side effects (send email, submit, delete, spend) to executors — those must pass a **Human Approval** node when Phase E lands.

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
