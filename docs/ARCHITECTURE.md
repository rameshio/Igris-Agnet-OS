# IGRIS Agent — System Architecture

> A personal AI operator OS (Next.js command center) and the visual workflow engine
> growing inside it: **G-Brain Flow**. This is the whole system as it stands, plus the
> architecture we are building toward, phase by phase.
>
> Status marker in this doc: **✅ live** · **▶ next** · **○ planned**.
> Last updated: **Phase E complete** (Human Approval node + durable pause/resume; Phase D logic nodes, references, mapping, branching, Parallel/Join). Companion docs: `AI-HANDOFF.md` (entry),
> `PHASE-STATUS.md` (status + invariants), `DATA-MODEL.md`, `CODING-METHODOLOGY.md`,
> `DECISIONS.md`. The root `AGENTS.md` carries the code-ownership map and rules.

---

## 1. Overview & stack

IGRIS is a web command center where a client connects tools and models, shapes their own
agents, and drives everything through the **Conductor**. It looks alive on day one thanks to
rich seeded data, but every surface reads through a repository layer so seeded tables can be
swapped for live sources without touching pages.

| Layer | Choice |
|---|---|
| Framework | Next.js 14 (App Router, React Server Components) |
| Language | TypeScript |
| Validation | Zod (every DB/API boundary) |
| Persistence | better-sqlite3 — `data/founder-os.db` (WAL, auto-seeded) |
| Canvas | React Flow v12 (`@xyflow/react`) |
| Brains / LLM | Hermes (persistent ACP), Vercel AI Gateway, OpenAI-compatible providers, stub |
| Tests | Vitest |
| Port | **4100** |

---

## 2. Core design rules

1. **Larp-first, real-ready.** Pages/routes never query SQLite directly — always the repo
   layer (`lib/db.ts`). Swapping a seeded table for a live source is a repo-level change.
2. **Three separated concerns — never merged:**
   - **Agents & Models** (`/agents`, `/models`) — who does the work + what they think on.
   - **G-Brain Flow** (`/flows`) — the executable workflow orchestrator.
   - **G-Brain knowledge** (`/brain`) — stored knowledge/memory + its graph visualization.
   The workflow engine never becomes the knowledge graph; not every LLM output becomes memory.
3. **Services, not components, orchestrate.** Execution/routing logic lives in `lib/*`
   (no React, unit-testable). The visual graph is a workflow **definition**; execution happens
   in backend services.
4. **Honest state.** Connectors report real status (never fake "connected"); unsupported nodes
   say so; failures surface with output, never silently.
5. **Definition vs. run history are separate.** Editable drafts vs. immutable versions vs.
   run records live in distinct tables.

---

## 3. Directory / module map

```
app/
  page.tsx                 operator console            api/agents/*       agent CRUD, run, chat
  agents/  models/         roster + model providers    api/models/route   provider connect/test
  flows/   brain/          orchestrator + knowledge    api/flows/*         workflow CRUD + versions
  api/agent-flows/*        legacy canvas (kept working)

lib/
  data.ts  db.ts  seed.ts  schemas.ts                  data + repos + Zod
  agents/  runtime.ts real.ts custom.ts chat.ts        agent registry + per-agent chat
           conductor.ts registry.ts                    Conductor router (operator mode)
  connectors/ llm.ts hermes-acp.ts gateway hermes-cli  LLM brains + provider adapters
              openai-compatible.ts gbrain.ts            direct providers + knowledge read
  models/  catalog.ts resolve.ts                        provider catalog + per-agent resolve
  flows/   schema.ts node-types.ts registry.ts         ORCHESTRATOR FOUNDATION (Phase A)
           validator.ts
  brain-dump.ts                                         knowledge write path

components/
  ConductorPanel.tsx  AgentBuilder.tsx  ModelsBoard.tsx
  AgentFlowCanvas.tsx                                   legacy canvas (kept working)
  flows/ FlowWorkspace.tsx  FlowCanvas.tsx              new typed orchestrator UI
```

---

## 4. Layered architecture

Requests descend the stack; services also reach outward to brains, providers, and the
knowledge store.

```mermaid
flowchart TD
  UI["UI · Next.js App Router + React Flow canvases<br/>/ · /agents · /flows · /brain · /models · Conductor dock"]
  API["API Routes · /api/*<br/>/api/flows · /api/agents · /api/models · /api/agent-flows"]
  SVC["Services · lib/* (no React, unit-testable)<br/>Conductor · Validator · Executor registry · Flow engine [C] · Model router [B]"]
  REPO["Repository layer · lib/db.ts (Zod-validated boundary)"]
  DB[("SQLite · data/founder-os.db (WAL)")]
  EXT["External · Hermes (ACP) · AI Gateway · provider APIs · G-Brain store"]

  UI --> API --> SVC --> REPO --> DB
  SVC --> EXT
```

The frontend graph is a **definition only**. `[B]`/`[C]` mark layers that arrive in later phases.

---

## 5. Data layer

- `lib/data.ts` — `getDb()` app singleton; seeds on first touch.
- `lib/db.ts` — `openDb()` builds the SQLite schema (`CREATE TABLE IF NOT EXISTS`), runs
  guarded `ALTER TABLE` migrations, and exposes repositories. **Migrations are additive and
  idempotent** (guarded by `pragma table_info` or a deterministic id/meta flag).
- `lib/schemas.ts` — Zod schemas validate rows on the way **out** of the DB.
- Pattern for any new data: **new repo method + Zod schema + seed entry + test.**

See §12 for the full table inventory.

---

## 6. Agents

- **Built-in roster** (`lib/agents/real.ts`) — code-defined agents, each 1:1 with a
  `RuntimeAgent` that has a real `run()`.
- **Custom agents** (`custom_agents` table + `lib/agents/custom.ts`) — pure data: a name,
  instructions (system prompt), tools, and a `model`. A generic runtime turns each row into a
  live `RuntimeAgent`, so a client creates/customizes agents with no code change.
- **Per-agent chat** (`lib/agents/chat.ts`) — builds the system prompt, calls the LLM layer
  with the agent's tools **and its `model`**, persists turns.
- **Conductor** (`lib/agents/conductor.ts`) — the operator brain. Three routes:
  1. `@agent …` → delegate to a specialist.
  2. An operator request (create/edit/delete/run an agent or the flow) → propose a structured
     **action** the UI confirms before executing (**confirm-each**, human-in-the-loop).
  3. Anything else → the Conductor answers directly, grounded in the current screen.

---

## 7. Model architecture

Agents are never bound to one provider. An agent carries a **strategy**; a router resolves it
to a concrete adapter at call time.

```mermaid
flowchart LR
  A["Agent node<br/>config + model"] --> S["Strategy<br/>Fixed · Hermes · Auto"]
  S --> R["Model Router<br/>(records fallbacks)"]
  R --> H["Hermes (ACP)"]
  R --> O["OpenAI · Anthropic"]
  R --> G["Google · xAI · NVIDIA"]
  R --> P["OpenRouter · Ollama"]
  R --> C["custom OpenAI-compatible"]
```

**Today (live):** `lib/connectors/llm.ts` `chat()` inspects the request's `model`:
- `providerId:modelId` (e.g. `openai:gpt-4o`) → routes to that **connected** provider via the
  OpenAI-compatible client (`lib/connectors/openai-compatible.ts`).
- otherwise → the active **brain** (default Hermes).

**Models board** (`/models`, `lib/models/*`): connect a provider with its API key (stored in
`.env.local`, gitignored), optional base URL, **test / live model fetch**. Providers today:
OpenAI, Anthropic, xAI, DeepSeek, Groq, Mistral, OpenRouter, Together (all OpenAI-compatible).

**Security:** keys never leave the backend. The frontend only learns whether a credential
exists; errors are redacted; the app-wide `model_provider_connections` table stores enabled
state, base URL, and health timestamps — **never** the key value.

**Model Router (Phase B, live):** `lib/models/router.ts` resolves an agent's strategy
(Fixed/Hermes/**Auto** = safe stub → `auto_not_implemented`) to a concrete adapter. Adapters:
Hermes (ACP) for `hermes`, and the OpenAI-compatible client for `fixed` providers
(OpenAI/Anthropic/Google/xAI/NVIDIA/DeepSeek/Groq/Mistral/OpenRouter/Together/Ollama/custom).
Per-agent model config lives in `AgentBuilder`; model badges show on flow agent nodes. No
silent fallback (`fallbackUsed` always false today).

### LLM brains (adapters)

| Adapter | Notes |
|---|---|
| `hermes-acp` | Persistent Hermes over an **ACP JSON-RPC/stdio** process — boot once, ~8s warm per call. Full Hermes (tools/MCP/memory). |
| `gateway` | Vercel AI Gateway (`ai` SDK) — `provider/model` strings, tool-calling. |
| `hermes-cli` | One-shot `hermes chat` — ~31s cold start per call (degraded emergency/manual path, NOT an automatic fallback). |
| `openai-compatible` | Direct `/chat/completions` to any connected provider. |
| `stub` | Deterministic, offline — tests. |

### 7.1 HermesClient seam (HRA-2 H1) ✅

The ModelRouter's `hermes` strategy reaches Hermes through one canonical seam,
`HermesClient` (`lib/connectors/hermes-client.ts`), rather than depending on ACP
details: `Agent → ModelRouter → HermesClient → ACP (production) → Hermes`. In H1 the
production client simply wraps the active brain (ACP by default) — **zero behavior
change** — while exposing `chat()`, `health()`, and tri-state `capabilities()`
(MCP/skills stay `'unknown'` per H0; ACP health is honestly `unknown`/`independentProbe:false`).

A **test-only** `HermesServeTransport` (`lib/connectors/hermes-serve.ts`) implements the
same interface over the H0-verified `serve` protocol (WS + JSON-RPC 2.0, `GET /api/status`,
`session.create` → `prompt.submit` → stream → `message.complete`, `session.interrupt`) to
prove the seam supports the future H3 transport swap. It is **not wired to production
traffic**; the ModelRouter still uses ACP. Process lifecycle, discovery, health polling, and
token acquisition are deliberately out of H1 (H2 owns them). The `hermes_unavailable` router
contract and the **no-silent-fallback** invariant are unchanged.

> **Two independent memory systems — do not conflate.** IGRIS **G-Brain** persistence
> (`/brain`, explicit read/write, "workflow outputs are NOT auto-written") is separate from
> **Hermes's own internal memory**, which H0 verified is **persistent across sessions** on the
> Hermes side, independent of IGRIS. A Hermes-backed agent may retain conversational memory even
> though IGRIS never wrote to G-Brain. How private/company/temporary sessions should interact with
> Hermes's persistent memory is an **open product decision required before serve reaches users** (pre-H3).

### HRA-2 (Hermes Runtime Architecture V2) status

| Checkpoint | State |
|---|---|
| **H0** — serve protocol/capability spike | ✅ complete (GO WITH CONDITIONS) |
| **H1** — HermesClient seam + serve test spike | ✅ complete — ACP still primary, serve disabled |
| **H2** — runtime discovery/health/lifecycle + Settings status | ✅ complete — `HermesRuntimeManager` + Settings ▸ Hermes Runtime; ACP still primary |
| **H3** — serve as a SELECTABLE production transport | ✅ complete (GO WITH CONDITIONS) — eligibility-gated, default ACP, no silent fallback; live-validated incl. Gmail workflow |
| H4 — remote Hermes · H5 — retire ACP | ▶ next / ○ planned |

**H3 production serve** (selectable, default ACP): `getHermesClient(db)` picks the transport from
`meta.hermes_production_transport` (default `'acp'`). Flipping to serve is **eligibility-gated**
(runtime healthy + Hermes-shaped `/api/status` + token configured) via `POST …/set_transport`; ACP
rollback is always allowed. **No silent fallback** — a serve failure surfaces `hermes_unavailable`.
Each agent-node run gets ONE fresh serve session (workflow isolation); **bounded concurrency** (default 3,
serve sessions run independently per the live experiment); layered timeouts (connect/request/inactivity)
with `session.interrupt` on timeout; per-request liveness = stream activity + the independent
`/api/status` channel (never `gateway_busy`/`serve --status`); approval events surface as
`hermes_approval_required` (never auto-answered — Phase E). Live-validated: serve workflow
(`brain:hermes-serve`) and the **Gmail workflow succeeded in ~114s with the health channel healthy
throughout and no ACP-style poisoning**. Conditions before serve could ever become a default: MCP
parity (server-side tools ran, but MCP-specific execution not isolated), skills parity (unverified),
and the persistent-memory isolation decision (dedicated Hermes profile — H4).

**H2 runtime manager** (`lib/connectors/hermes-runtime.ts`, `GET/POST /api/settings/hermes-runtime`, Settings ▸ Hermes Runtime): discovers the Hermes binary (configured/`HERMES_BIN` → PATH → known per-OS locations, validated by `<bin> --version`), probes serve health via **`GET /api/status`** (never `serve --status`), and models runtime **state** (`not_installed`/`installed`/`starting`/`healthy`/`degraded`/`unreachable`/`stopped`/`crashed`), **mode** (`managed_local`/`external_local`/`remote`-future), and **ownership** — a 200 on the port is **not** ownership; only a process IGRIS launched with a live PID is `managed`. Optional managed start/stop is PID-exact (never `serve --stop`, never an external/shared server). Non-secret config lives in the `meta` KV (no migration); the serve **token lives only in `.env.local`** (`HERMES_SERVE_TOKEN`), presence-only to the UI. This subsystem is **orthogonal to production traffic** — the ModelRouter still uses ACP.

---

## 8. G-Brain Flow — the orchestrator

A workflow is a **directed graph of typed nodes + edges**, executed in dependency order.

### 8.1 Node system

Nodes are a discriminated union on `type`; each type owns a config schema + a registered
executor (`lib/flows/schema.ts`, `node-types.ts`, `registry.ts`). Adding a type is one
`register(...)` call — never a scattered switch. Colour is always paired with an icon + text.

| Node | Category | Runnable in |
|---|---|---|
| Input | io | Phase C ✅ |
| AI Agent | agent | Phase C ✅ |
| Tool | tool | later ○ |
| Decision | logic | Phase D ✅ |
| Human Approval | human | Phase E ✅ |
| Memory (G-Brain) | memory | Phase F ○ |
| Transform | transform | Phase D ✅ |
| Parallel / Join | control | Phase D ✅ |
| Output | io | Phase C ✅ |

Until its phase lands, a placed node renders honestly as **"not runnable yet · Phase X"** (now only
Memory / Tool) — the canvas never pretends an unsupported node works. Edges carry a
`mapping` — `all` (whole output) or, in Phase D, `field` / `template` / `object` resolving
`{{Node.field}}` references — plus an optional `condition` (conditional edges).

### 8.2 Execution engine & run lifecycle  ✅ (Phase C, branching in Phase D)

Execution is a backend concern, decoupled from React Flow.

```mermaid
flowchart LR
  Def["Definition<br/>(version)"] --> Val["Validator v1"] --> Eng["Engine<br/>dep order"]
  Eng --> Reg["Executor registry<br/>agent · tool · decision · approval · memory …"]
  Reg --> RT["Model Router · Tools · G-Brain"]
```

Run lifecycle (state persisted per node so the UI polls, not one blocking request):

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> running
  running --> waiting_approval
  waiting_approval --> running: approve → resume from node
  running --> success
  running --> failed
  running --> skipped
```

The engine threads a **typed** workflow state (not concatenated text), persists each node-run
incrementally, and (once Phase E lands) will **pause at approval nodes and resume from that node**
rather than restarting.

#### 8.2.1 Logic engine — references, conditions, mapping, branching  ✅ (Phase D)

Phase D extends (never replaces) the engine with an **active-edge** model:

- **References** (`lib/flows/references.ts`): one resolver for `{{Node.field}}` / `{{Node.data.x.0}}`.
  Read-only property/path lookup — **no `eval`**, and `__proto__`/`prototype`/`constructor` are
  rejected. A whole-string reference preserves the value's native type; inline references stringify
  deterministically. Missing references throw `workflow_reference_not_found` (never silent-empty).
- **Conditions** (`lib/flows/conditions.ts`): one typed `{ left, operator, right? }` evaluator shared
  by Decision nodes and conditional edges (14 operators). `equals` is strict; numeric comparators do
  an explicit safe numeric conversion.
- **Input resolution** (`lib/flows/inputs.ts`): `resolveNodeInputs` merges a node's ACTIVE incoming
  edges under mapping modes `all` / `field` / `template` / `object`, deterministically (sorted by
  source id).
- **Scheduler** (`lib/flows/engine.ts`): an edge is *active* only when its source succeeded AND is
  selected — a Decision activates the edge whose `sourceHandle` matches the chosen route
  (first-match, optional default); a conditional edge activates on truth. A node with incoming edges
  but no active one is **skipped** (`branch_not_selected` / `upstream_skipped`); a node that errors is
  **failed**. Topological visitation means Join sees every branch already terminal, so it waits only
  for active branches and never stalls on a skipped one. Executors: `transform` (declarative reshape),
  `decision`, `parallel` (control fan-out), `join` (wait-for-all-active, branches keyed by stable
  label). Runtime detail (selected route, transform result, join branches, skip reason) persists in
  existing `flow_node_runs` JSON — **no new tables**.

#### 8.2.2 Human Approval — durable pause/resume  ✅ (Phase E)

A **Human Approval** node is a durable pause-point, kept separate from the machine-logic Decision node.
When the scheduler reaches an unresolved approval node it writes a `pending` `flow_approvals` row, marks
the node + run **`waiting_approval`**, and RETURNS — the run is now durable state in SQLite. It survives
browser refresh, hot-reload, and full process restart (the coordinator's reconciler only touches
`running` runs, so a paused run is never marked `interrupted`).

`resumeWorkflowRun(runId)` (`resumeRun` in `engine.ts`, launched by the coordinator's `resumeRunBg`)
reloads the **immutable** version, rebuilds the scheduler `state`/`status` from the persisted node runs —
so a succeeded Agent/tool node is **never re-executed** (no upstream LLM/tool re-calls) — applies the
human decision, and continues. The resolved approval node routes exactly like a Decision: its
`output.data.selectedRoute` is the approve or reject route, activating only the matching `sourceHandle`
edge. A **rejection is a normal outcome** down the reject branch (node status `rejected`, NOT `failed`;
the run still finishes `success`). Resolution is **idempotent** — a conditional `UPDATE … WHERE
status='pending'` means approving twice resolves once and resumes once; the `globalThis` active set is
the resume lock. Endpoints (`/api/flow-approvals/*`) are backend-authoritative: the client sends only the
approval id + decision + note, and `context_json` holds non-secret data only. Hermes-originated approval
events surface as `hermes_approval_required` and are never auto-answered (session continuation deferred).

### 8.3 Persistence — draft vs. immutable version  ✅ (Phase A)

- `flow_workflows` — workflow identity + metadata + **editable draft graph** + `current_version`
  pointer.
- `flow_versions` — **immutable** graph snapshots, `UNIQUE(workflow_id, version)`.
- Normal **Save** updates the draft (no version churn). **Publish** freezes the draft into a new
  immutable version — so a historical run always references a stable definition.
- **Workflow lifecycle (delete/archive/rename).** `flow_workflows.archived_at` enables history-safe
  removal: `removeOrArchiveWorkflow` (`lib/flows/workflow-admin.ts`) hard-deletes a history-free draft
  but **archives** any workflow with versions/runs so immutable versions + run/approval audit survive
  (`flowWorkflows.all()` hides archived by default). Rename is trim + non-empty; duplicate names are
  allowed (id is identity). Never touches legacy `agent_flows`. See D21.
- **Node editing/deletion (draft-only).** The canvas inspector edits every node's `label` +
  `description` + type config; **deleting** a node removes it and all connected edges via the pure
  `lib/flows/graph-ops.ts` (`removeNodeFromGraph`), on the draft only — published versions are never
  mutated until the next Publish. Keyboard delete is guarded (`shouldDeleteSelection`/`isEditableTarget`)
  so Backspace-while-typing edits text; React Flow's built-in delete key is disabled.

### 8.4 API  ✅ (Phase A)

```
GET  /api/flows                    list workflows
POST /api/flows                    create { name }
GET  /api/flows/:id                workflow + draft graph + versions
PATCH /api/flows/:id               save draft graph and/or rename (name trimmed, non-empty; validation non-blocking)
DELETE /api/flows/:id              delete-or-ARCHIVE (backend decides: history → archive, else hard delete) → {mode}
GET  /api/flows/:id/versions       list versions
POST /api/flows/:id/versions       publish draft as immutable version (validated; invalid → 400)

# Human Approval (Phase E)
GET  /api/flow-approvals           pending approvals inbox (non-secret rows)
GET  /api/flow-approvals/:id       one approval
POST /api/flow-approvals/:id/approve   resolve + resume down the approve route { note? }
POST /api/flow-approvals/:id/reject    resolve + resume down the reject route  { note? }
```

### 8.5 Validator  ✅ (v1 + Phase-D checks)

`lib/flows/validator.ts` (pure) detects: duplicate node ids · dangling edges · self-edges ·
missing agent references · malformed configs · invalid edge refs · **cycles (DAG-only)** ·
empty workflow. **Phase D adds:** malformed/unknown reference sources (static, ROOT only) · Decision
with no rules/default · duplicate route names · edges leaving a Decision with an undeclared route
handle · Join with no incoming edges · invalid mapping/condition shapes. Non-blocking on draft save;
blocking on publish. (Runtime path existence is deliberately NOT proven statically.)

### 8.6 Migration of the legacy canvas  ✅

On DB open, the legacy `agent_flows` "main" canvas imports **once** into workflow `wf-main`
(draft + immutable v1), preserving name, node positions, agent references, and edges. Idempotent
(keyed on `wf-main`); the old table is **never deleted**; `/api/agent-flows` + `AgentFlowCanvas`
stay operational during the transition.

---

## 9. G-Brain knowledge (kept separate)

- Markdown knowledge in a local brain-store with an embeddings backend + CLI provider
  (`lib/connectors/gbrain.ts`), plus the radial / neural graph on `/brain`. A map of stored
  knowledge — **not** agents, **not** execution.
- **Memory rule:** runs do **not** auto-dump every LLM output into permanent knowledge. Memory
  is an explicit per-node choice (read/write/mode), conservative by default. Transient run data
  stays in run history unless promoted (Phase F).

---

## 10. Security & human-in-the-loop

- **Secrets stay backend.** API keys in `.env.local` (gitignored); frontend learns only whether
  a credential exists; errors redacted.
- **A connection is not consent.** A visual edge never authorizes a destructive act. Sending
  mail, submitting an application, deleting data, spending money → must pass a first-class
  **Human Approval** node.
- **Remove ≠ Delete.** Taking a node off the canvas keeps the agent; deleting the agent is a
  separate, two-step, everywhere action.

---

## 11. Conventions & testing

- **TDD**: failing test first. Tests in `tests/`, one per module; `openDb(':memory:')` /
  `FOUNDER_OS_DB=:memory:` for isolation. Stub LLM/brain providers keep tests offline.
- **Zod-validate** anything crossing the DB or API boundary.
- **Theme**: Monolith Signal (mono) default; JetBrains Mono; square corners; hairline borders;
  status-only colour. Tokens in `tailwind.config.ts` + `app/globals.css`.
- **Gates before "done"**: `tsc --noEmit` (no lint script in repo) + relevant tests + full-suite
  regression.
- Heavy visualizations load via `next/dynamic` (`ssr: false`) behind sized skeletons.

---

## 12. Data model (table inventory)

| Table | Holds | Status |
|---|---|---|
| `custom_agents` | Client-authored agents (name, instructions, tools, model) | ✅ |
| `agents` · `departments` · `tools` | Built-in roster + org scaffolding | ✅ |
| `agent_runs` · `agent_messages` | Per-agent run + chat history (model, tokens, cost) | ✅ |
| `agent_flows` | Legacy single canvas — kept working during transition | ✅ compat |
| `flow_workflows` | Workflow identity + metadata + **draft graph** + current-version pointer | ✅ Phase A |
| `flow_versions` | **Immutable** graph snapshots — `UNIQUE(workflow_id, version)` | ✅ Phase A |
| `model_provider_connections` | App-wide provider status/enabled/base-URL/last-check — **never the secret** | ✅ Phase B |
| `flow_runs` · `flow_node_runs` | Run + per-node execution state, tokens, duration, errors | ✅ Phase C |
| `flow_approvals` | Human-approval decisions bound to a paused run/node | ○ Phase E |

(Plus the many operational/business tables: metrics, funnel, social, roadmap, skills, people, …)

---

## 13. Roadmap to done

Each phase is independently shippable and test-gated, with an approval checkpoint before the
next. Nothing ships as one risky rewrite.

| Phase | Delivers | Status |
|---|---|---|
| **A · Foundation** | flow_* schema + migration, typed node/edge schemas, executor registry, validator v1, `/flows` route, create/version/save, main-flow import | ✅ done |
| **B · Model routing** | ModelRouter (Fixed/Hermes/Auto), provider connections, per-agent model config + node badges, wider adapters | ✅ done |
| **C · Execution engine** | dependency execution, typed structured state, persisted runs/node-runs, Run Inspector (poll) | ✅ done |
| **D · Logic nodes** | decision/router, transform, parallel/join, conditional edges + `{{Node.field}}` mapping | ✅ done |
| **E · Human approval** | approval node, durable pause/resume, approval UI, destructive-action gates | ▶ next |
| **F · Memory** | explicit G-Brain read/write nodes, controlled knowledge promotion | ○ planned |
| **G · Reliability** | retries, error routes, recorded model fallback, versioning polish | ○ planned |

**End state:** *G-Brain Flow is a visual AI workflow orchestration engine* where agents, models,
tools, logic, human approvals, and memory connect into executable workflows — a purpose-built AI
orchestration environment, not a node diagram. The job-application pipeline is **one workflow it
can run**, never a behavior baked into the engine.

---

## 14. Key files

| Concern | Files |
|---|---|
| Data / repos | `lib/data.ts`, `lib/db.ts`, `lib/schemas.ts`, `lib/seed.ts` |
| Agents | `lib/agents/runtime.ts`, `real.ts`, `custom.ts`, `chat.ts`, `conductor.ts` |
| Models | `lib/models/catalog.ts`, `resolve.ts`, `lib/connectors/openai-compatible.ts`, `llm.ts` |
| Brains | `lib/connectors/hermes-acp.ts`, `hermes-cli.ts`, `gateway` (in `llm.ts`) |
| Flow foundation | `lib/flows/schema.ts`, `node-types.ts`, `registry.ts`, `validator.ts` |
| Flow engine + logic (D) | `lib/flows/engine.ts`, `coordinator.ts`, `references.ts`, `conditions.ts`, `inputs.ts`, `executors/*` |
| Flow API | `app/api/flows/route.ts`, `[id]/route.ts`, `[id]/versions/route.ts`, `[id]/runs/route.ts`, `runs/[runId]/route.ts` |
| Flow UI | `app/flows/page.tsx`, `components/flows/FlowWorkspace.tsx`, `FlowCanvas.tsx`, `InspectorPanel.tsx` |
| Knowledge | `lib/brain-dump.ts`, `lib/connectors/gbrain.ts` |
| Legacy (compat) | `app/api/agent-flows/*`, `lib/agents/flow-run.ts`, `components/AgentFlowCanvas.tsx` |
