# IGRIS CLI + Unified Model Control Plane

`igris` is a terminal **control surface** over the running IGRIS Agent OS. It is **not a
second operating system**: it speaks only to the canonical HTTP API (`http://localhost:4100`
by default), so validation, permissions, Phase-E approval, and canonical state all stay
server-side — the CLI behaves exactly like the UI.

> **Principle:** CLI = control surface, not authority. **Provider ≠ Model ≠ Runtime
> Transport ≠ Agent.** The unified Model Runtime is the single provider abstraction.
> **No silent fallback** between providers.

## Running

```bash
npm run cli -- status            # during development (via tsx, no build step)
```

After `npm link` (optional), the `igris` bin is available:

```bash
igris status
```

Target another server with `IGRIS_BASE_URL` or `--base-url`:

```bash
IGRIS_BASE_URL=http://localhost:4100 igris status
igris status --base-url http://localhost:4100
```

## Commands

| Command | What it does | Kind |
|---|---|---|
| `igris status` | reachability + safe company/runtime summary | read |
| `igris models [providers]` | providers, configured/connected state, capabilities | read |
| `igris models current` | the effective global default model | read |
| `igris models use <provider> <model>` | set the global default (canonical config) — also `use hermes\|auto\|default` | write |
| `igris ask "<question>" [--model p:m]` | read-only company question, answered by the configured model | read |
| `igris mission list\|show <id>` | list / show missions | read |
| `igris mission create "<title>" [--objective "…"]` | create a mission | write |
| `igris mission plan\|step\|archive <id>` | plan / one manager tick / archive | write |
| `igris task list --mission <id>` | tasks under a mission | read |
| `igris task show\|eligible <id>` | task detail / eligible agents + tool gaps | read |
| `igris task dispatch <id>` | dispatch (server enforces capability/tool preflight) | write |
| `igris artifact show <id>` | full operator-readable result | read |
| `igris artifact promote <id>` | promote to G-Brain (explicit, idempotent) | write |
| `igris brain search "<q>"` / `entity <id>` / `neighborhood <id>` | G-Brain reads | read |
| `igris brain promote-artifact <id>` | promote an artifact to G-Brain | write |
| `igris intelligence [--window 1h\|24h\|7d\|30d]` | Company Intelligence signals | read |
| `igris flow list\|show <id>` | workflows | read |
| `igris flow run <id> [--input "…"]` | run a **published** workflow | write |
| `igris approvals` | pending human approvals | read |
| `igris approval approve\|reject <id> [--note "…"]` | resolve an approval (backend-authoritative) | write |
| `igris shell` | interactive REPL over the same commands | — |

## Global flags

- `--json` — machine-readable output (for automation).
- `--yes` — skip the confirmation prompt on mutations. **It never bypasses Phase-E
  approval** — the server owns that regardless of the flag.
- `--base-url URL` — target server.
- `--help` — usage.

## Mutations: preview → confirm → execute

Every write command shows a preview and asks `Continue? [y/N]`. In a non-interactive
session without `--yes`, the mutation is refused (exit code 4) rather than performed
silently. Even with `--yes`, workflow runs pause at Phase-E approval nodes and approvals
are resolved only through the backend-authoritative endpoints.

## Exit codes

`0` success · `1` failure · `2` invalid input · `3` server unavailable · `4` approval
required / action not completed.

## Model control plane

The unified Model Runtime (`lib/models/*`, `routeModel`) is the single provider abstraction.
Providers (OpenAI, Anthropic, Google Gemini, xAI, DeepSeek, Groq, Mistral, OpenRouter,
Together, NVIDIA, Ollama, Custom) are reached through one OpenAI-compatible client; the
**AI Gateway** and **Hermes** brains remain available and unchanged. Feature code never
instantiates a provider directly — it goes through the runtime.

**Model selection hierarchy:** `explicit run override → agent model → global default → brain ('')`.
The global default is persisted server-side (the `meta` key `default_model`, set via
`igris models use` / `POST /api/models/default`).

**Capabilities:** each provider carries honest capability metadata (`text`, `tool_calling`,
`structured_output`, `vision`). `MODEL_CAPABILITY_MISMATCH` guards selecting a model that
cannot do tool calling for a tool-backed task.

**Providers vs secrets:** `GET /api/models/providers` returns configured/connected state
and capabilities — **never** an API key. Keys live server-side in `.env.local`; the CLI
never sends, stores, or prints them, and applies a defensive secret-redaction pass to all
output. Optional non-secret CLI config may live in `~/.igris/config.json` (`baseUrl`,
`outputFormat`) — credential-looking fields there are ignored.

**No silent fallback:** a configured model that fails returns an explicit provider/runtime
error (e.g. `auth_failed`, `hermes_unavailable`, `model_capability_mismatch`). The CLI
surfaces it; it never quietly retries on a different provider.
