# AGENTS.md — instructions for AI coding agents

> Written for **any** AI coding agent (Claude Code, Codex, OpenCode, Gemini CLI,
> Cursor, …). Platform-independent. All knowledge needed to work on this
> repository lives in the repository — never rely on prior chat history. If a
> document and the code disagree, **the code is the source of truth** — fix the doc.
>
> (`CLAUDE.md` also exists with the same house rules in a Claude-specific voice;
> this file is the platform-neutral entry point.)

## Project

**IGRIS Agent** — a personal AI operator OS: a Next.js command center where a
user connects tools and models, shapes their own AI agents, and builds/executes
visual AI workflows. Runs locally on port **4100**.

## First read, in order

1. [`docs/AI-HANDOFF.md`](docs/AI-HANDOFF.md) — what the project is, the product split, phase status.
2. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current implemented architecture (post-Phase C).
3. [`docs/CODING-METHODOLOGY.md`](docs/CODING-METHODOLOGY.md) — how code is written here.
4. [`docs/PHASE-STATUS.md`](docs/PHASE-STATUS.md) — what is LIVE / PLANNED / LEGACY + architectural invariants.
5. [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md), [`docs/TESTING-GUIDE.md`](docs/TESTING-GUIDE.md), [`docs/DECISIONS.md`](docs/DECISIONS.md), [`docs/SECURITY.md`](docs/SECURITY.md), [`docs/LEGACY.md`](docs/LEGACY.md), [`docs/EXTENDING.md`](docs/EXTENDING.md) — as needed.

Then **inspect the repository and verify the docs match the code** before changing anything.

## The three separated concerns (never merge them)

- **`/agents` + `/models`** — *who* performs work + *what intelligence* powers them.
- **`/flows`** — *what executes* (visual workflow orchestration).
- **`/brain`** — *what is known* (G-Brain knowledge + memory + its graph).

## Mandatory rules

- **Inspect before modifying.** Read the relevant files, tests, and DB schema; reuse existing abstractions.
- **Never start a new product phase** (D/E/F/G) unless explicitly instructed. See `docs/PHASE-STATUS.md`.
- **Preserve architectural boundaries** and the invariants in `docs/PHASE-STATUS.md § Architectural invariants`.
- **Maintain backward compatibility.** Do not break existing agents, legacy flow API, model settings, or DB data.
- **Do not expose secrets.** API keys live only in `.env.local`; never return, log, or persist them. See `docs/SECURITY.md`.
- **Do not fake functionality.** Unsupported nodes/providers must say so; never a fake "connected"/"success".
- **Use the repository layer** (`lib/db.ts` repos) — never query SQLite from a page/route.
- **Use the `ModelRouter`** (`lib/models/router.ts`) for model execution — never scatter provider calls.
- **Use the executor registry** (`lib/flows/registry.ts`) for flow execution — no giant `switch (node.type)`.
- **Runs execute PUBLISHED immutable versions**, never mutable drafts.
- **Do NOT auto-write workflow output to G-Brain** (memory is Phase F, explicit only).
- **Migrations are additive/idempotent/non-destructive.** Follow `lib/db.ts` conventions (see `docs/DATA-MODEL.md`).
- **Validate at boundaries with Zod** (DB reads, API payloads, persisted JSON).
- **Update docs in the same checkpoint** as any architecture/API/DB/behavior change, and add a `docs/CHANGE-LOG.md` record + `CHANGELOG.md` entry.
- **Do not commit or push** unless explicitly asked. Don't kill the dev server on 4100. `/org` markup is frozen.

## Validation gate (before claiming a task done)

1. `npm run typecheck` (`tsc --noEmit`) — must pass. **There is no lint script; do not claim lint passed.**
2. Targeted tests for what you changed.
3. `npm test` (full Vitest suite) for meaningful changes.
4. Manual smoke test for runtime behavior.
5. Security check where secrets/providers are involved.

Then produce the change report described in `docs/CODING-METHODOLOGY.md § End-of-task change report`.

## Code ownership — "to change X, start here"

| Concern | Canonical files |
|---|---|
| Database schema + repositories | `lib/db.ts` |
| Zod row schemas | `lib/schemas.ts` (+ `lib/flows/*.ts`, `lib/models/types.ts`) |
| App DB singleton + seed | `lib/data.ts`, `lib/seed.ts` |
| Agent runtime / registry | `lib/agents/runtime.ts`, `registry.ts`, `real.ts` |
| Custom agents | `lib/agents/custom.ts` |
| Per-agent chat | `lib/agents/chat.ts` |
| Conductor (operator brain) | `lib/agents/conductor.ts` |
| Model routing | `lib/models/router.ts` |
| Model strategy parse/serialize/badge | `lib/models/settings.ts` |
| Provider catalog | `lib/models/catalog.ts` |
| Provider connection resolve/status | `lib/models/connections.ts`, `resolve.ts` |
| LLM brains / transports | `lib/connectors/llm.ts`, `hermes-acp.ts`, `hermes-cli.ts`, `openai-compatible.ts` |
| Workflow graph schema | `lib/flows/schema.ts` |
| Node type metadata (client-safe) | `lib/flows/node-types.ts` |
| Node executor registry | `lib/flows/registry.ts` |
| Node executors | `lib/flows/executors/{input,agent,output,index}.ts` |
| Workflow validator | `lib/flows/validator.ts` |
| Workflow execution engine | `lib/flows/engine.ts` |
| Run coordinator (in-process) | `lib/flows/coordinator.ts` |
| Flow persistence (definition) | `lib/db.ts` repos `flowWorkflows`, `flowVersions` |
| Run persistence | `lib/db.ts` repos `flowRuns`, `flowNodeRuns` |
| Flow API | `app/api/flows/**` |
| Flow UI | `components/flows/FlowWorkspace.tsx`, `FlowCanvas.tsx` |
| Models UI/API | `components/ModelsBoard.tsx`, `app/api/models/route.ts` |
| Agent builder UI | `components/AgentBuilder.tsx` |
| Knowledge store (G-Brain) | `lib/brain-dump.ts`, `lib/connectors/gbrain.ts` |
| Navigation | `lib/nav.ts` |
| Credentials resolution | `lib/creds.ts` |
| Legacy flow (compat only) | `lib/agents/flow-run.ts`, `app/api/agent-flows/*`, `components/AgentFlowCanvas.tsx` |

## Current status & next task

- **Completed:** Phase A (workflow foundation) · Phase B (unified model runtime) · **Phase C (execution engine + Run Inspector)**.
- **Next planned phase (do NOT start without instruction):** **Phase D — Logic nodes** (Decision, Transform, Parallel/Join, conditional edges, `{{Node.field}}` mapping). Start point: extend `resolveIncomingInputs` in `lib/flows/engine.ts` and the reserved `mapping`/`condition` fields on `WorkflowEdgeSchema` in `lib/flows/schema.ts`; register new executors via `lib/flows/executors/index.ts`.

## What NOT to do

Rewrite the repo from scratch · replace SQLite / `ModelRouter` / executor registry without a project decision · bypass repositories · move workflow execution into React · run mutable drafts · mutate immutable versions · store runtime status in graph JSON · auto-write LLM output to G-Brain · expose provider keys · build new `/flows` features on the legacy engine (`lib/agents/flow-run.ts`) · implement later phases unrequested · introduce a parallel competing system instead of extending · remove compatibility code without a migration plan · silently change product behavior.

## House commands

```bash
npm run dev        # dev server → http://localhost:4100
npm test           # full Vitest suite
npm run typecheck  # tsc --noEmit
npm run seed       # re-seed data/founder-os.db (idempotent)
```

## House rules (preserved)

- Credentials live in `.env.local` (gitignored) and are resolved by `lib/creds.ts`. Never copy secret values into the repo.
- Don't kill the dev server on port 4100 — other sessions/tools use it. A crash loop corrupts `.next`; if hot reload breaks, kill the port, `rm -rf .next`, restart.
- `/org` markup is frozen — inherit theme tokens via Tailwind classes, do not restructure.
- Theme is **Monolith Signal** (mono) by default; tokens in `tailwind.config.ts` (`os.*`) and `app/globals.css` (kept in sync).
