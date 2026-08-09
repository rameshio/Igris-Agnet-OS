# RELEASE-PROCESS

> How to treat this repository as continuously-maintained production software.
> "It compiles" is not "production ready."

## Release states

- **Development** — work in progress on a phase/checkpoint.
- **Ready for validation** — checkpoint code complete, self-tested.
- **Release candidate** — full validation gate passed (below), docs + changelog updated.
- **Released** — accepted by the product owner; changelog `Unreleased` moved under a version/date.
- **Hotfix** — an urgent, minimal fix to a released state.

## Release / validation gate

A release candidate must have:

1. Scope completed; **no unapproved next-phase work** included.
2. `npm run typecheck` clean. *(There is no lint script — do not claim lint.)*
3. Targeted tests pass.
4. `npm test` full suite green (re-run the known flaky seed/api pair if it trips under parallel load).
5. Migrations verified: additive, idempotent, non-destructive; a migration/idempotency test where a table/backfill was added.
6. Security checks where relevant (no secret persisted/returned/logged; errors redacted; blank-credential behavior).
7. Manual smoke test of the changed runtime behavior.
8. `CHANGELOG.md` updated; `docs/CHANGE-LOG.md` record added.
9. Known issues updated (`CHANGELOG.md § Known Issues`, `PHASE-STATUS.md`).
10. Rollback notes recorded.

## Release checklist (copy per change)

```
[ ] Scope completed
[ ] No unapproved next-phase work included
[ ] Typecheck passes
[ ] Targeted tests pass
[ ] Full suite passes
[ ] API compatibility verified
[ ] Database migration verified (additive/idempotent)
[ ] Secrets/security checked (no leak, redaction, blank-credential)
[ ] Manual smoke test completed
[ ] Backward compatibility checked (agents, legacy flow API, model settings, DB data)
[ ] CHANGELOG.md updated
[ ] docs/CHANGE-LOG.md record added
[ ] Known limitations documented
[ ] Rollback path documented
[ ] Architecture docs updated if architecture/API/DB/behavior changed
```

## Database migrations

- Normal form: **additive, idempotent, non-destructive, backward compatible.** New table → `CREATE TABLE IF NOT EXISTS`; new column → guarded `ALTER TABLE` (pragma-checked). Backfills/imports must be idempotent (keyed on a deterministic id or a `meta` flag) and must never delete source data (see `flowMaintenance.importMainFlow`).
- Every migration records: tables/columns/indexes added, backfill, trigger, idempotency mechanism, compatibility impact, rollback limitations (in `docs/CHANGE-LOG.md`).
- A **destructive** migration is exceptional: **STOP** and document why, the backup requirement, the migration + rollback procedure, and the data-loss risk before proceeding. Never perform one silently.

## Rollback thinking

- For every meaningful change, state whether it can be rolled back safely and how.
- **Code rollback ≠ schema rollback.** Additive schema changes usually stay in place after a code revert (unused columns/tables are harmless). Prefer **forward-fix** for additive migrations unless a safe schema rollback exists.
- External-secret changes (a deleted/rotated key) have **no automated rollback** — recovery is re-entering the credential.

## Hotfix process

1. Identify the production-impacting issue. 2. Minimize scope. 3. Reproduce. 4. Add a regression test. 5. Fix only the affected behavior — no unrelated refactors. 6. Validate the impacted area. 7. Run the full suite if feasible. 8. Record the incident (`docs/INCIDENTS.md`). 9. Update `CHANGELOG.md`. 10. Document rollback. Hotfixes must not smuggle in new features.

## Observability expectations

Operational failures must be diagnosable from persisted data: run id, workflow
id/version, node id, provider/model identifiers, `error_code`, duration, status
transitions (on `flow_runs`/`flow_node_runs`). **Never** log or persist API keys,
Authorization headers, raw secrets, or env contents. Reuse existing structures;
do not add a second logging system.
