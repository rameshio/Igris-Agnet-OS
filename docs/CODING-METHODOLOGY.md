# CODING-METHODOLOGY

> How code is written in this repository. This describes the methodology actually
> used through Phases A–C, and the standard every future change must follow. The
> repository is maintained like a continuously-maintained production codebase:
> optimize for correctness, traceability, backward compatibility, security,
> testability, recoverability, clear ownership, and incremental delivery — not
> "make it work quickly."

## 1. Inspect before modifying
Before implementing anything: read the relevant files, their tests, the DB
schema/repositories, and identify reusable abstractions. Never blindly replace
working architecture. Explain the current behavior to yourself first.

## 2. Phase-gated development
Large work is split into explicitly scoped phases (see `PHASE-STATUS.md`). Each
phase has explicit non-goals, is independently testable, and must be completed
before the next starts. **Never auto-start a later phase.**

## 3. Test-gated checkpoints
Implement significant work in checkpoints (e.g. B1…B6, C1…C6). After each
checkpoint: typecheck → targeted tests → fix regressions → continue.

## 4. Additive migrations
DB migrations are additive, idempotent, non-destructive, backward compatible.
New table → `CREATE TABLE IF NOT EXISTS`; new column → guarded `ALTER TABLE`
(pragma-checked). No destructive migration without an explicit, documented plan
(`RELEASE-PROCESS.md § Migrations`).

## 5. Reuse before rewrite
Extend registries, adapters, services, repositories. Do not create a parallel
competing system. Examples: add a node type by registering an executor (not a
new engine); add a provider by extending the catalog (not a new router).

## 6. Services, not components
Business logic lives in `lib/**` (no React, unit-testable). React components must
NOT contain workflow execution, model routing, database access, or secret logic.
The visual graph is a **definition**; execution happens in backend services.

## 7. Zod at boundaries
Validate DB reads, API payloads, and persisted JSON with Zod. Infer types from
schemas where practical.

## 8. Honest states
Never fake `connected` / `running` / `supported` / `success`. Unsupported
functionality says so (e.g. flow nodes render "not runnable yet · Phase X";
`auto` fails with `auto_not_implemented`). Connectors report real status.

## 9. Security
Never expose API keys, Authorization headers, or env secrets — not in responses,
logs, errors, or DB rows. See `SECURITY.md`.

## 10. Backward compatibility
Do not break existing agents, the legacy flow API, model settings, or DB data
without a migration plan. Legacy code stays until explicitly retired (`LEGACY.md`).

---

## Code style & conventions (as the codebase actually uses them)

- **TypeScript:** explicit types on exported/public APIs; avoid `any` (use `unknown` + narrowing). Prefer `type` aliases and discriminated unions (e.g. `WorkflowNode` discriminated on `type`, `ConductorAction` on `kind`).
- **Interfaces vs types:** `interface` for extensible shapes (e.g. `NodeExecutor`, `LlmProvider`); `type` + Zod for data shapes and unions.
- **Zod:** schema modules export both the schema and the inferred type (`export type X = z.infer<typeof XSchema>`). String-literal status enums declared `as const` (e.g. `RUN_STATUSES`).
- **Repositories:** all DB access via `lib/db.ts` repo objects with methods like `get/all/create/update/upsert/remove`. Row → domain mapping via `rowToX` helpers; JSON columns parsed defensively.
- **IDs:** stable unique ids, typically `prefix-${randomUUID()}` (`run-…`, `nr-…`, `wf-…`, node ids like `agent-…`). Deterministic ids where idempotency matters (`wf-main`, `wf-main-v1`).
- **Timestamps:** ISO 8601 strings (`new Date().toISOString()`), stored as TEXT.
- **JSON persistence:** structured payloads stored as JSON TEXT (`graph`, `draft_graph`, `starting_input`, `input_json`, `output_json`, `tools`); node output shape is `{ text?, data? }`.
- **Async/errors:** `async/await` with `try/catch`; narrow `unknown` errors. Domain errors carry a string `code` (`ModelRouteError.code`, `NodeExecError.code`) so callers can persist a normalized `error_code` without knowing the source. Error messages are redacted before storage/surfacing (`lib/flows/errors.ts redactSecret`, `lib/models/router.ts normalizeAdapterError`).
- **Registry pattern:** `NodeExecutorRegistry` (`lib/flows/registry.ts`) — one `register()` per node type; executable executors registered via `lib/flows/executors/index.ts`. No scattered `switch (node.type)`.
- **Adapter pattern:** LLM transports behind `LlmProvider` (`lib/connectors/llm.ts`): `stub`, `hermes-acp`, `hermes-cli`, `gateway`, `openai-compatible`. Providers spoken via the OpenAI-compatible client where they support it.
- **UI:** Next.js App Router. Server Components by default; `'use client'` only where needed (canvases, boards). Heavy visualizations via `next/dynamic({ ssr:false })`. Theme = **Monolith Signal** tokens (`tailwind.config.ts` `os.*` + `app/globals.css`, kept in sync); square corners, hairline borders, status-only color, JetBrains Mono. `/org` markup is frozen.
- **Naming:** components `PascalCase`; hooks `useX`; constants `UPPER_SNAKE_CASE`; files kebab/camel per existing neighbors.
- **Module boundaries:** client-safe modules (`lib/flows/schema.ts`, `node-types.ts`, `lib/models/settings.ts`, `catalog.ts`) must not import server-only code; server-only logic (engine, coordinator, router, executors, db) stays out of client bundles.

## Safe-change workflow (every future change)

1. Read the docs (`AGENTS.md`, this file, `ARCHITECTURE.md`, `PHASE-STATUS.md`).
2. Inspect the files related to the change + their tests + DB schema.
3. Explain current behavior.
4. Identify the **smallest safe change**.
5. Write/update tests first where practical.
6. Implement one checkpoint.
7. Typecheck + targeted tests; fix regressions.
8. Continue checkpoints.
9. Run the full suite for meaningful changes.
10. Update docs (`ARCHITECTURE.md`/`DATA-MODEL.md`/`PHASE-STATUS.md` as relevant), `CHANGELOG.md`, and `docs/CHANGE-LOG.md`; record an incident/RCA if warranted.

## Bug-fix methodology

1. Reproduce the failure. 2. Capture expected behavior. 3. Add a **failing regression test** where practical (named around behavior — e.g. `"does not run the same flow run twice on concurrent start"`). 4. Find the **root cause** (not symptoms). 5. Make the **smallest correct fix**. 6. Targeted tests → subsystem tests → full suite for meaningful changes. 7. Update `CHANGELOG.md` / `docs/CHANGE-LOG.md`; add an `docs/INCIDENTS.md` RCA if impact warrants. No random trial-and-error edits.

## Failure-state rules

Never hide failure (`catch { return 'success' }` is banned; no silent model
fallback; no fake `connected` because a key exists). Failed operations end in
explicit states — `failed`, `interrupted`, `skipped`, `unavailable` — with a
normalized `error_code`, useful diagnostics, and secrets redacted.

## Observability / diagnostics

Operational code should make failures diagnosable: run id, workflow id/version,
node id, provider/model identifiers, `error_code`, duration, status transitions
are persisted on `flow_runs`/`flow_node_runs`. **Never log** API keys,
Authorization headers, raw secrets, or env contents. Do not invent a second
logging system.

## Documentation changes with code

Documentation is part of the implementation. If a change alters architecture,
API, DB schema, workflow/provider/security behavior, or phase status, update the
relevant docs in the **same checkpoint**. Do not leave docs knowingly stale.

## Git / commit conventions (do not commit unless asked)

Organize work as if it were a reviewable PR. Recommended commit boundaries:
schema/migration · domain logic · API · UI · tests/docs. Message style:
```
feat(flows): add persisted workflow execution
fix(models): prevent disabled provider routing
test(flows): cover interrupted run recovery
docs(architecture): document Phase C engine
security(models): redact provider errors
```

## Definition of Done

A task is done only when: implementation complete · scope boundaries respected
(no unrequested next-phase work) · types valid · tests pass · failure cases
tested · security reviewed where relevant · migration checked · backward
compatibility considered · docs updated · change history updated
(`CHANGELOG.md` + `docs/CHANGE-LOG.md`) · known limitations documented ·
rollback/recovery considered.

## End-of-task change report

Every meaningful task ends with a PR-style report:

**Summary** (what was requested, what changed, why) · **Files** (added/modified/removed) ·
**Architecture** (impact, new/reused abstractions, invariants touched) ·
**Database** (schema changes, migration behavior, rollback) ·
**API** (routes/contracts changed, compatibility) ·
**Failures encountered** (symptom → root cause → fix → regression test — do not hide failed attempts that changed the final strategy) ·
**Testing** (added, targeted, typecheck, full suite, manual smoke) ·
**Security** (secret handling, approval impact, redaction) ·
**Known limitations** · **Rollback/recovery** · **Next safe step**.
