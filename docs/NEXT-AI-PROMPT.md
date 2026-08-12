# NEXT-AI-PROMPT — copy/paste to hand off to another AI coding platform

> Paste the block below into a fresh session on any agentic coding platform
> (Codex, OpenCode, Gemini CLI, Cursor, Claude Code, …). It is
> platform-independent and repository-grounded.

---

```
You are continuing development of IGRIS Agent, a personal AI operator OS
(Next.js 14 + TypeScript + SQLite, local dev on port 4100). It has three
intentionally separate concerns:
  - /agents + /models : who performs work + what intelligence powers them
  - /flows            : what executes (visual AI workflow orchestration)
  - /brain            : what is known (G-Brain knowledge + memory)
Do not merge these concerns.

BEFORE CHANGING ANY CODE:
1. Read AGENTS.md (repo root).
2. Read docs/AI-HANDOFF.md.
3. Read docs/ARCHITECTURE.md.
4. Read docs/CODING-METHODOLOGY.md.
5. Read docs/PHASE-STATUS.md (status matrix + architectural invariants).
6. Skim docs/DATA-MODEL.md, docs/TESTING-GUIDE.md, docs/DECISIONS.md,
   docs/SECURITY.md, docs/LEGACY.md, docs/EXTENDING.md.
7. Inspect the repository and VERIFY the documentation matches the code.
   If they disagree, the CODE is the source of truth — note the mismatch.

COMPLETED PHASES (do not redo or undo):
- Phase A — Workflow foundation (typed nodes/edges, drafts + immutable
  versions, validator, executor registry, multiple workflows, legacy import).
- Phase B — Unified model runtime (ModelRouter: fixed/hermes/auto-stub;
  providers incl. Google/NVIDIA/Ollama/custom; per-agent model config;
  model badges; app-wide model_provider_connections).
- Phase C — Execution engine + Run Inspector (Input/Agent/Output execute
  through the engine + ModelRouter; flow_runs/flow_node_runs persistence;
  in-process coordinator + polling; Run Inspector + canvas status overlay).
- Phase D — Logic engine (references lib/flows/references.ts; one condition
  evaluator lib/flows/conditions.ts for Decision + conditional edges; edge
  mapping all/field/template/object lib/flows/inputs.ts; Transform/Decision/
  Parallel/Join executors; active-edge scheduler with skip-vs-fail in
  lib/flows/engine.ts; canvas node/edge inspectors). No new DB tables.

CURRENT NEXT PHASE (do NOT start until the human explicitly approves it):
- Phase E — Human approval: approval node, durable pause/resume, approval UI +
  table (flow_approvals) + endpoints, destructive-action gates.
  Notes: NodeRunStatus already reserves waiting_approval. Decision (machine
  logic, Phase D) and Human Approval (human gate, Phase E) are SEPARATE — do not
  merge them. Do NOT reuse the legacy lib/agents/flow-run.ts engine (it
  auto-writes to G-Brain). Reuse the executor registry + engine, don't replace.

HARD RULES (from AGENTS.md / docs/PHASE-STATUS.md invariants):
- Inspect before modifying; reuse abstractions; do not rewrite from scratch.
- Never start a new phase without explicit instruction.
- Use the repository layer (lib/db.ts) — never query SQLite from a page/route.
- Use the ModelRouter (lib/models/router.ts) for model execution.
- Use the executor registry (lib/flows/registry.ts) for flow execution
  (no scattered switch statements).
- Runs execute PUBLISHED immutable versions, never mutable drafts.
- Never write runtime status into workflow definition JSON.
- Do NOT auto-write workflow output to G-Brain (memory is Phase F, explicit).
- Provider secrets live only in .env.local — never in DB rows, responses, or logs.
- Do not fake connected/running/supported/success; fail honestly.
- Migrations are additive/idempotent/non-destructive.
- Do not build new /flows features on the legacy engine (lib/agents/flow-run.ts);
  do not remove legacy code without a migration plan.
- Keep docs in sync in the same checkpoint; update CHANGELOG.md and
  docs/CHANGE-LOG.md; record incidents/RCAs in docs/INCIDENTS.md when warranted.

VALIDATION GATE (there is NO lint script — do not claim lint):
1) npm run typecheck   2) targeted tests   3) npm test (full suite)
4) manual smoke test   5) security check where secrets/providers are involved.

FIRST RESPONSE:
Do NOT write code yet. First summarize your understanding of:
- the three separated concerns,
- what is LIVE vs PLANNED vs LEGACY,
- the invariants you must not break,
- and the smallest safe first step for the task I am about to give you.
Then wait for my confirmation.
```
