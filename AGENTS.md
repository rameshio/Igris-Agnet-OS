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
| Human approval (Phase E) | `lib/db.ts` repo `flowApprovals`, `lib/flows/approvals.ts`, `lib/flows/executors/approval.ts`, engine `handleApproval`/`resumeRun`, `app/api/flow-approvals/**`, `components/ApprovalsInbox.tsx`, `app/approvals/page.tsx` |
| Flow API | `app/api/flows/**`, `app/api/flow-approvals/**` |
| Flow UI | `components/flows/FlowWorkspace.tsx`, `FlowCanvas.tsx` |
| Models UI/API | `components/ModelsBoard.tsx`, `app/api/models/route.ts` |
| Agent builder UI | `components/AgentBuilder.tsx` |
| Knowledge store (G-Brain) | `lib/brain-dump.ts`, `lib/connectors/gbrain.ts` |
| Navigation | `lib/nav.ts` |
| Credentials resolution | `lib/creds.ts` |
| Legacy flow (compat only) | `lib/agents/flow-run.ts`, `app/api/agent-flows/*`, `components/AgentFlowCanvas.tsx` |

## Current status & next task

- **Completed:** Phase A–D · **Phase E — Human approval** (Human Approval node + durable pause/resume: `flow_approvals` table, `resumeWorkflowRun`, approve/reject API, Approvals inbox, canvas config; run status `waiting_approval`, node status `rejected`; approve/reject route like a Decision; resolution is idempotent and never re-runs succeeded nodes; Hermes-native approval continuation deferred, never auto-approved) · **HRA-2 H0** (serve spike) · **H1** (HermesClient seam) · **H2** (HermesRuntimeManager) · **HRA-2 H3** (serve is a SELECTABLE, eligibility-gated production transport — **default stays ACP**, no silent fallback; live-validated incl. the Gmail workflow. GO WITH CONDITIONS).
- **UX Foundation ✅ COMPLETE:** U1 ✅ Context Envelope · U2 ✅ Unified Commander · U3 ✅ Plan→Preview→Execute · U4 ✅ Activity / Ops Stream · U5 ✅ Approval Decision Cards + Agent Presence · **U6 ✅ Commander Home** (Home = AI-native operating surface: briefing + Commander entry + operational summary, composed read-only from U4/U5 + repos via `GET /api/home`; not an analytics dashboard, not a second command system; the old business dashboard moved to its own pages, nothing deleted). See `docs/ARCHITECTURE.md` §9e–§9f.
- **Architecture V2 (audit: GO WITH CHANGES) — F0.1 ✅ Company Registry Capability layer:** first-class Capabilities (`domain.action`) over the existing agent registry + a deterministic, exact-id resolver (`resolveAgentsForCapabilities`) so the future F1 Manager finds workers by capability. Registry/data/resolution ONLY — no execution/delegation. Additive `capabilities`/`agent_capabilities` tables keyed by canonical agent id (built-in OR custom-*, no FK). See `docs/ARCHITECTURE.md` §6b. **Registry semantics:** `Capability` = what an agent CAN do · `Skill`/`Tool`/`Model` = what SUPPORTS it · `Permission` = what it MAY do · `Approval` (Phase E) = human authorization. A capability is never a permission; resolution never executes.
- **Architecture V2 — F0.2 ✅ Mission + Company Task canonical model:** first-class company-work layer (Mission = objective, Company Task = work unit), DISTINCT from the existing `agent_tasks` kanban. Data model (`lib/company/model.ts`) + canonical service (`lib/company/service.ts`) + narrow APIs (`/api/missions/*`, `/api/company-tasks/*`) + minimal Missions UI (`/missions`, `MissionsBoard.tsx`). Guarded status transitions; parent/subtask hierarchy (same-mission, cycle-rejected); task dependencies (same-mission, acyclic, idempotent; `prerequisitesSatisfied` read-only). F0.1 capability-assisted manual assignment (409 if incompatible). `workflowId`/`runId` reference seams (never runs anything). Additive `company_missions`/`company_tasks`/`company_task_dependencies` + 6 indexes. See `docs/ARCHITECTURE.md` §6c.
- **Architecture V2 — F1 ✅ Executive Manager / Delegation Engine:** the **Executive Manager** (the evolved Conductor, `role: 'executive_manager'` — no duplicate id, still the chat/ASK brain) plans a Mission, decomposes it into Company Tasks, capability-matches (F0.1, deterministic + U5 presence refinement), and DELEGATES to an existing agent (`createRuntime(...).run`) OR an existing **published** workflow (`startRun`) — reusing existing infra (NO parallel engine). First-class **Artifact** (`company_artifacts`, no G-Brain ingestion) + append-only **event ledger** (`company_events`, not canonical state) + `executionKind`/`executionRefId` on tasks (never overloads workflow `runId`). Bounded `managerStep` (≤3, no autonomous loop), idempotent + durable dispatch, deterministic mission completion. Capability gap → **F1 never creates an agent (that is F2)**. Human Approval reuses Phase E (no `company_approvals`). Roles kept separate: Commander = owner surface · Executive Manager = AI manager agent · Workflow Engine = SOP executor. `lib/company/manager/*` + `/api/missions/:id/{plan,manager-step,report,events}` + `/api/company-tasks/:id/dispatch` + `/api/company-artifacts/:id`. See `docs/ARCHITECTURE.md` §6d.
- **Architecture V2 — F2 ✅ Agent Factory:** controlled, human-gated dynamic agent creation that fills the F1 `CAPABILITY_GAP`. The operator triggers a proposal (no auto-propose, no loop); an LLM proposes an agent spec, but the **SERVER owns policy** (`FactoryPolicy`: connector-backed tool allow-list bounded in count, allow-listed model, bounded instructions, `maxDepth`, `canSpawn=false`; a violating spec fails safe and creates nothing). **Proposal-first / create-on-approve:** the pending `company_agent_proposals` row is the only artifact until a human approves — **`createCustomAgent` runs ONLY on promotion** (reused under a policy wrapper, not forked). Promotion reuses the Phase-E idempotent-resolve PATTERN (conditional `WHERE status='pending'`), NOT the `flow_approvals` table, and adds no second approval authority; it assigns EXACTLY the task's gap capabilities → the F1 resolver now matches → next Manager Step dispatches. Factory agents are temporary + mission-bound (retired on mission completion; disabled + unassigned, reversible). Additive `company_agent_proposals` table; `custom_agents` schema unchanged. `lib/company/factory/{model,service}.ts` + `/api/company-tasks/:id/propose-agent` + `/api/agent-proposals/:id/{approve,reject}` + `/api/missions/:id/proposals`. See `docs/ARCHITECTURE.md` §6e.
- **Architecture V2 — F3 ✅ G-Brain Core:** the canonical, durable, in-app company knowledge layer — Entities, Relationships, Knowledge, Sources/provenance in SQLite. DISTINCT from the *external* gbrain markdown store (`lib/brain.ts`) and the *visualization* graphs (`lib/brain-graph.ts`/`knowledge-graph.ts`/`memory-core.ts`, all untouched). **Four graphs stay separate** (organization → registry · workflow → Flow engine · **knowledge → G-Brain Core** · execution → mission/task/run/event — never merged). REFERENCES canonical objects via `canonical_key` (one entity per ref; never copies tools/model/status/permissions). **Explicit ingestion ONLY** — no auto-write of LLM output/artifacts/task results/chat/events, and NO agent write path to canonical G-Brain (the external `saveToGBrain` tool is a separate system, unchanged). Artifact→brain **promotion** is the one explicit seam (idempotent; artifact never modified; no auto-ingest; provenance Knowledge ← Artifact ← Agent ← Task ← Mission). Confidence nullable/never fabricated; keyword search only (no vector DB/Neo4j); Hermes memory ≠ G-Brain. `lib/brain/core/*` + `/api/brain/{entities,relationships,knowledge,sources,search}` + `/api/company-artifacts/:id/promote-to-brain`; `BrainCorePanel` on `/brain` + Promote button on `/missions`. Additive `brain_entities`/`brain_relationships`/`brain_knowledge`/`brain_sources`. See `docs/ARCHITECTURE.md` §6f.
- **Architecture V2 — F4 ✅ G-Brain Radial + Universal Inspector:** the canonical F3 knowledge layer becomes an interactive structural view ("what is connected to this thing?"). **Radial is a PROJECTION, not a source of truth** — it reads/resolves the owning systems and never persists. **A projection node ≠ a persisted BrainEntity and a projected edge ≠ a persisted BrainRelationship:** `Mission HAS_TASK Task` is projected live from Company Core and is NEVER written to `brain_relationships`; `Knowledge DERIVED_FROM Artifact` is a persisted F3 edge; each is tagged `persisted`. Viewing a canonical object never auto-creates a BrainEntity. Bounded (depth ≤ 2, ≤100 nodes/200 edges); strict `parseEntityRef` (no arbitrary query from URL). The **Universal Inspector** resolves any kind into a safe typed view (never prompts/model/tool-creds/`context_json`) and is a CONTROL SURFACE, not authority — privileged/execution actions deep-link to the owning surface's existing U3/Phase-E confirm; only safe Promote/Archive are inline `api` actions. `lib/brain/projection/*` + `lib/brain/inspector/*` + `/api/brain/{radial,inspect}` (read-only) + `BrainWorkspace`/`BrainRadial`/`UniversalInspector` on `/brain` (above the untouched org viz). NO DB change. See `docs/ARCHITECTURE.md` §6g.
- **Architecture V2 — F5 ✅ G-Brain Neural:** the Neural tab is now the live/recent OPERATIONAL graph (missions → tasks → agents → workflow runs → approvals → artifacts) — "what is happening through these connections right now?". **Neural is a read-only PROJECTION, not a runtime:** `company_events` supplies the historical edge + timestamp, and CURRENT canonical state (`task.status`/`mission.status`/`flow_run.status`/`approval.status`/presence) is the sole authority for STATUS (never stale-event replay). Bounded (window default 60 min; ≤250 events/150 nodes/300 edges), safe (never prompts/tokens/`context_json`/startingInput/outputs/tool args), polled (~5s, no-overlap, off-tab-paused; **no WebSockets**). No `company_events` into Radial; **no `event → BrainKnowledge`**. Additive `company_events` read methods only (**no new table**). `lib/brain/neural/*` + read-only `/api/brain/neural` + `BrainNeural` + Inspector `workflow_run`/`event` kinds. See `docs/ARCHITECTURE.md` §6h.
- **Immediate next (do NOT start without instruction):** **Architecture V2 · F6 — Company Intelligence** (utilization / success-rate / throughput / bottleneck / cost / duplicate-capability analytics + recommendations — NOT started; F4/F5 show raw/recent state only, never derived analytics). F6 has NOT started; do not begin without instruction. Deferred F5 follow-ons (do NOT start unrequested): push/WebSockets, force-directed neural layout, richer approval resolution for direct-agent tasks. Deferred F4 follow-ons: in-place node expansion (vs re-root focus), radial minimap, d3-force layout. Deferred F3 follow-ons: embedding/vector search, legacy-markdown bulk import, knowledge hard-delete. Deferred F2 follow-ons: hard runtime budget metering (agent_runs `cost_usd` seam), per-department factory policies, semantic capability matching, department-manager hierarchy. HRA-2 H4 (remote Hermes) remains an independent option — do NOT make serve the default for new users yet; `getHermesClient(db)` chooses the transport from `meta.hermes_production_transport` (default `acp`), ACP + INC-005 protections stay as rollback. Approval follow-ons NOT yet built (do not start unrequested): approval expiry/TTL (the `expired` status is defined but unused), an auth layer (resolver actor is hard-coded `local_operator`), and Hermes-session approval continuation. See `docs/PHASE-STATUS.md` + `docs/DECISIONS.md` D17–D20.

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
