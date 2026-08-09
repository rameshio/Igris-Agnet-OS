# AI-HANDOFF — start here

> Entry document for an AI coding agent (or engineer) continuing IGRIS Agent
> with no prior context. Read this, then `ARCHITECTURE.md`,
> `CODING-METHODOLOGY.md`, and `PHASE-STATUS.md`. Verify docs against code before
> changing anything — **code is the source of truth.**

## What is this project?

**IGRIS Agent** is a personal AI operator OS — a single web command center
(Next.js 14, TypeScript, SQLite, runs locally on port **4100**) where one user:

- connects **model providers** and **tools**,
- shapes their own **AI agents** (name + instructions + tools + model strategy),
- drives the app through the **Conductor** (an operator brain), and
- builds and executes **visual AI workflows** (G-Brain Flow).

It ships with rich seeded data so every page is alive without configuration
(the "larp-first, real-ready" rule: swapping seed data for live sources is a
repository-layer change, never a page change).

## The product split (intentionally separate concerns — never merge)

| Surface | Meaning | Route |
|---|---|---|
| **Agents + Models** | *Who* performs work + *what intelligence* powers them | `/agents`, `/models` |
| **G-Brain Flow** | *What executes* — the visual workflow orchestrator | `/flows` |
| **G-Brain** | *What is known* — stored knowledge, memory, and the knowledge graph | `/brain` |

Rules that follow from the split:
- Models are **app-wide**, not owned by `/flows`.
- Flow nodes **reference agents**; agents **own their default model strategy**.
- The workflow engine is **not** the knowledge graph.
- Workflow output is **not** automatically written to G-Brain (memory is explicit, Phase F).

## Key terms

- **Agent** — a `RuntimeAgent`: built-in (code-defined in `lib/agents/real.ts`) or custom (a `custom_agents` row turned live by `lib/agents/custom.ts`). Has instructions, tools, and a model strategy.
- **Model strategy** — how an agent thinks: `fixed` (a connected direct provider + model), `hermes` (the active brain), or `auto` (a safe, not-yet-implemented stub). Stored compactly in the agent's `model` string.
- **ModelRouter** (`lib/models/router.ts`) — the one app-wide entry that resolves a strategy to a concrete adapter and executes, returning metadata.
- **Hermes** — a first-class local **brain/runtime** reached over ACP (a persistent JSON-RPC-over-stdio process). NOT a normal API-key provider card.
- **Direct providers** — OpenAI, Anthropic, Google, xAI, NVIDIA, DeepSeek, Groq, Mistral, OpenRouter, Together, Ollama (local), and a custom OpenAI-compatible endpoint. All spoken via the OpenAI-compatible client.
- **Workflow** — a directed graph of typed nodes + edges. A **draft** is editable; a **published version** is immutable.
- **Run** — one execution of one immutable version; **node runs** record each node's execution.

## How it fits together (one line)

`/flows` builds a workflow → publish an immutable **version** → **run** it → the
backend **engine** walks nodes in dependency order → agent nodes call the
**ModelRouter** → Hermes or a direct provider → each step persists to
`flow_node_runs` → the **Run Inspector** shows results. Knowledge in `/brain` is
reached only by explicit memory behavior (Phase F, not built).

## Current development phase

- **Completed:** Phase A (workflow foundation) · Phase B (unified model runtime) · **Phase C (execution engine + Run Inspector).**
- **Next planned:** **Phase D — Logic nodes** (Decision, Transform, Parallel/Join, conditional/field edges). **Do not start it without explicit instruction.**
- See `PHASE-STATUS.md` for the full LIVE / PLANNED / LEGACY matrix and invariants.

## Known limitations (post-Phase C)

- Workflow execution is **sequential** (parallel/join is Phase D).
- Only **Input / AI Agent / Output** nodes execute; all other node types are placed-but-rejected-before-run.
- **Auto** model strategy is a stub — it fails clearly with `auto_not_implemented`, never silently picks a model.
- No model **fallback**, **retries**, or **cancel** yet (Phase G).
- Hermes ACP does not report token usage → node token counts are `null` (honest, not 0); estimated cost is `null` (no fabricated pricing).
- Stale-run detection is **on read** (a `running` run not tracked in the process → `interrupted`); there is no background sweeper and no auto-resume after a crash.

## Deeper docs

- `ARCHITECTURE.md` — current implemented architecture + module map + ownership.
- `CODING-METHODOLOGY.md` — how to write code here (inspect-first, phase-gated, test-gated, additive migrations, reuse, services-not-components, Zod, honest states, security, backward compat) + change-report format.
- `DATA-MODEL.md` — every table; draft vs version vs run vs node-run.
- `TESTING-GUIDE.md` — framework, in-memory SQLite, stubs, secret-leak tests, the validation gate.
- `DECISIONS.md` — why the architecture is the way it is (do not casually reverse).
- `SECURITY.md`, `LEGACY.md`, `EXTENDING.md`, `RELEASE-PROCESS.md`, `INCIDENTS.md`, `CHANGE-LOG.md`.
- `NEXT-AI-PROMPT.md` — a copy-paste prompt to hand another AI platform.
- Root: `AGENTS.md` (rules), `CHANGELOG.md` (release notes), `CLAUDE.md` (Claude-voice house rules), `README.md` (product overview).
