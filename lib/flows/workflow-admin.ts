/**
 * Workflow lifecycle service (delete / archive) for the /flows orchestrator.
 *
 * The delete DECISION lives here, not in React or the route body, so the policy
 * is backend-authoritative and unit-testable. Policy (see docs/DECISIONS.md D21):
 *
 *  - A workflow with NO history (no published versions, no runs) → hard delete.
 *    Nothing audit-worthy is lost.
 *  - A workflow WITH history (any flow_versions OR flow_runs) → soft-archive
 *    (`archived_at`). Immutable versions and run/approval audit records survive;
 *    the workflow simply leaves the active list.
 *
 * This only ever touches the flow_* tables — the legacy agent_flows system is
 * never affected.
 */
import type { FounderDb } from '@/lib/db';

export type RemoveOutcome =
  | { ok: true; mode: 'deleted' | 'archived'; reason: string }
  | { ok: false; code: 'not_found' };

/**
 * Remove a workflow the safe way: hard delete when it has no history, otherwise
 * archive it. Returns which path was taken (and why) so the UI can explain it.
 */
export function removeOrArchiveWorkflow(db: FounderDb, id: string): RemoveOutcome {
  const wf = db.flowWorkflows.get(id);
  if (!wf) return { ok: false, code: 'not_found' };

  if (db.flowWorkflows.hasHistory(id)) {
    db.flowWorkflows.archive(id);
    return { ok: true, mode: 'archived', reason: 'has published versions or run history (audit preserved)' };
  }
  db.flowWorkflows.remove(id);
  return { ok: true, mode: 'deleted', reason: 'no history — safe to hard delete' };
}
