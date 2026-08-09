# TESTING-GUIDE

> Framework: **Vitest** (`^2.1`). Tests live in `tests/` (currently ~124 files,
> ~1070+ tests), one file per module/subsystem. There is **no lint script** —
> `tsc --noEmit` is the static gate. Do not claim lint passed.

## Running tests

```bash
npm test                                   # full suite
npm run typecheck                          # tsc --noEmit (static gate)
npx vitest run tests/flow-engine.test.ts   # a single file
npx vitest run tests/flow-engine.test.ts tests/flow-run-api.test.ts   # several
npx vitest run -t "auto strategy"          # by test name
```

> Known flaky pair: two seed/api render tests can intermittently time out under
> full-suite parallel load; they pass in isolation and on re-run. Re-run before
> assuming a real regression.

## In-memory / isolated SQLite

- Unit/repo/engine tests use `openDb(':memory:')` directly (from `lib/db`) — a fresh throwaway DB per test, no seeding, no shared state.
- API/page tests that need the app singleton set `process.env.FOUNDER_OS_DB` to a temp file in `beforeAll` (see `tests/smoke-api.test.ts`, `tests/flow-run-api.test.ts`). `getDb()` then opens that file.

## Stubbing models / providers (never call real paid APIs)

- **Brain / LLM:** set `process.env.LLM_PROVIDER = 'stub'` in `beforeAll`. The stub (`lib/connectors/llm.ts`) is deterministic and makes no network call, so `hermes` strategy and `chatWithAgent` resolve instantly. Restore the previous value in `afterAll`.
- **Direct providers (fixed strategy):** stub `global.fetch` with `vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '…' } }], usage: {…} }) })))` and set the provider's env key (e.g. `process.env.NVIDIA_API_KEY`). `afterEach(() => { vi.restoreAllMocks(); delete process.env.NVIDIA_API_KEY; })`.
- **Credentials in tests:** to avoid touching the real `.env.local`, mock `@/lib/creds` with an in-memory map (see `tests/models-api.test.ts`) so `upsertEnvLocal/readEnvLocal/runtimeEnv` never write the real file.
- **Tests MUST NOT require real Hermes, OpenAI, NVIDIA, Ollama, or any paid API.**

## What the test suites cover (reference)

- **Schema/validator:** `tests/flows-schema.test.ts`, `flows-validator.test.ts` — discriminated node parse, edge defaults, execution-validity, cycle/dangling/missing-agent detection.
- **Persistence round-trips:** `flows-repo.test.ts`, `flow-runs-repo.test.ts` — create/update/get, JSON output round-trip, nullable usage/cost, immutable version freeze, no secret columns.
- **Migration idempotency:** `flows-migration.test.ts` — legacy `agent_flows` "main" imports once, preserves name/positions/agents/edges, never deletes the source.
- **Model layer:** `model-settings.test.ts` (parse/serialize/backward-compat), `model-connections.test.ts` (metadata/health, no secret), `model-router.test.ts` (fixed/hermes/auto/disabled/missing/credential/model errors), `agent-model-routing.test.ts` (chat through router).
- **Model API + security:** `models-api.test.ts` — secret never returned, blank key doesn't erase, enable/disable, test action.
- **Workflow engine:** `flow-engine.test.ts` — Input→Agent→Output happy path, topo order (ignores X/Y), metadata persistence (Hermes + fixed), Auto fails honestly, missing agent, provider error, downstream skip, unsupported-node rejection, deterministic multi-predecessor merge, and a **structural guard that the engine/agent executor never import the G-Brain write path**.
- **Run API:** `flow-run-api.test.ts` — start (published version), poll to completion, 409 unpublished, 404 missing, history, no secret in payload.
- **Structural:** `orphans.test.ts` (no unused components except an allowlist — `AgentFlowCanvas` is allowlisted as legacy), `smoke.test.ts` (every page renders), `smoke-api.test.ts` (every GET route answers 200; id-dependent dynamic routes are in an `IGNORE` set), `nav.test.ts`.

## Migration testing

New tables/columns: add a repo round-trip test and (for imports/backfills) an
**idempotency test** (run the migration twice → single result; source untouched).
See `flows-migration.test.ts` as the template.

## API secret-leak testing

For any route touching providers/credentials: assert the raw secret string never
appears in the JSON response and that response objects have no `apiKey`/`key`
field (see `models-api.test.ts`, `flow-run-api.test.ts`).

## The validation gate (before marking any phase/checkpoint complete)

1. `npm run typecheck` — clean.
2. Targeted tests for the change.
3. `npm test` — full suite green (re-run the known flaky pair if needed).
4. Manual smoke test of runtime behavior.
5. Security regression where secrets/providers are involved.

There is **no lint**. Do not add a lint claim to reports.
