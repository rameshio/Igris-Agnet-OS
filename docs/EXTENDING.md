# EXTENDING — how to add providers, node types, and agents

> Follow the methodology in `CODING-METHODOLOGY.md`: inspect first, reuse
> registries/adapters, test-gate, keep migrations additive, update docs.

## A. Add a new model provider

Most providers are reachable via the shared **OpenAI-compatible** client — reuse
it; only write a provider-specific adapter if the provider's API genuinely
differs (do not fake compatibility).

1. **Catalog metadata** — add an entry to `MODEL_PROVIDERS` in `lib/models/catalog.ts`: `{ id, name, envKey, baseUrl, docsUrl, models, requiresKey?, local?, allowBaseUrl? }`. Keyless/local providers set `requiresKey:false`; local/custom set `allowBaseUrl:true`.
2. **Adapter** — if OpenAI-compatible, none needed (routing already uses `createOpenAiCompatibleProvider`). If not, add an adapter in `lib/connectors/` implementing the `LlmProvider` shape and branch it in `lib/models/router.ts`'s fixed path (keep the branch minimal; do not scatter provider logic elsewhere).
3. **Model discovery** — OpenAI-compatible `/models` is fetched by `fetchProviderModels` (`lib/connectors/openai-compatible.ts`), exposed via the `test` action. Provide a curated `models` list as fallback.
4. **Connection test** — handled generically by `POST /api/models {action:'test'}` (real backend check + `recordCheck`). Nothing to add unless the adapter differs.
5. **Metadata persistence** — `model_provider_connections` is generic (enabled/base_url/status). No per-provider table. **Never store the key.**
6. **UI card** — `ModelsBoard.tsx` renders all catalog providers automatically; cloud vs local is split by the `local` flag; `allowBaseUrl` shows a base-URL input.
7. **Routing** — `ModelRouter` (`lib/models/router.ts`) resolves `fixed` via `resolveConnection` (catalog + row + env key). Works automatically for OpenAI-compatible providers.
8. **Tests** — extend `model-router.test.ts` / `models-api.test.ts` (mock `fetch`, set the env key). Assert the secret is never returned.
9. **Security** — key only in `.env.local`; response exposes `hasCredential` only; errors redacted.

## B. Add a new workflow node type

The node system is a discriminated union + an executor registry — adding a type
must **not** require scattered `switch` statements.

1. **Zod config schema** — add `XConfigSchema` and register it in `NODE_CONFIG_SCHEMAS` in `lib/flows/schema.ts`.
2. **Discriminated node type** — add `X` to `NODE_TYPES` and a `nodeOf('x', XConfigSchema)` member of `WorkflowNodeSchema`.
3. **Node metadata (client-safe)** — add to `NODE_TYPE_META` in `lib/flows/node-types.ts`: label, category, color, icon, `executable`, `runnablePhase`, description. Until executable, keep `executable:false` and set the honest phase.
4. **Validator** — `validateNodeConfig` and `validateWorkflowGraph`/`validateExecutable` (`lib/flows/validator.ts`) pick up the config schema automatically; the registry auto-registers a config-only validator.
5. **Executor (only when its phase allows execution)** — implement `NodeExecutor` in `lib/flows/executors/x.ts` (`type`, `executable:true`, `validateConfig`, `execute(ctx) → { output, meta? }`), then register it in `lib/flows/executors/index.ts` (this overrides the config-only stub). Agent-like nodes must route model calls through `ModelRouter` — never call providers directly.
6. **UI node renderer** — `FlowCanvas.tsx` renders every type generically from `NODE_TYPE_META` (color+icon+label+status). Add an icon mapping if new. Add to the palette (it already maps `NODE_TYPE_LIST`).
7. **Inspector / config UI** — add per-type config editing if the node needs it (keep it in the client component; no server logic).
8. **Execution validation** — `validateExecutable` rejects any node whose executor is not `executable`; once you ship an executor, it becomes runnable automatically.
9. **Tests** — schema parse, validator, and (if executable) an engine test using the stub brain.
10. **Docs** — update `PHASE-STATUS.md` (move it LIVE) and `ARCHITECTURE.md`.

> Edge behavior for new nodes goes through `resolveIncomingInputs` (`lib/flows/engine.ts`) — extend that single function, don't embed edge logic in executors.

## C. Add a new agent

Two paths:

**Custom agent (data-driven — the normal path):**
- Create via `POST /api/agents` (or `createCustomAgent` in `lib/agents/custom.ts`): `{ name, departmentId, instructions, tools, model, enabled }`.
- `instructions` = the system prompt. `tools` = integration slugs (only wired ones in `lib/agents/agent-tools.ts` become callable). `model` = strategy-encoded string (`''`→hermes, `providerId:modelId`→fixed, `auto`→auto). See `lib/models/settings.ts`.
- `buildCustomRuntimeAgent` turns the row into a live `RuntimeAgent` (used by chat, runs, flow agent nodes).

**Built-in agent (code-defined — for real bespoke `run()` behavior):**
- Add to `lib/agents/real.ts` as a `RuntimeAgent` with a hand-written `run()`. Every seeded agent row maps 1:1 to a runtime agent (enforced by seed tests).
- Built-ins are resolvable the same way as custom agents (`allRuntimeAgents(db)` in `lib/agents/registry.ts`), so they work as flow agent nodes and through the ModelRouter where applicable. Do not force a bespoke `run()` through the router if it would break its intended semantics.

**Runtime resolution / chat:** agents are resolved by id via `allRuntimeAgents(db)`. Per-agent chat (`chatWithAgent`) builds the system prompt and routes through `ModelRouter`. Workflow agent nodes use the same router but persist to `flow_node_runs` (not `agent_messages`).

**Tests:** custom-agent CRUD + a chat test with `LLM_PROVIDER=stub`; if it references a fixed provider, mock `fetch`.
