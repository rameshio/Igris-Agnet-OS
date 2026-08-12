/**
 * Approval resolution service (Phase E).
 *
 * The ONE place a human decision is applied. The caller (API) supplies only the
 * approval id, the decision, and an optional note — EVERYTHING else (run id,
 * workflow, node, routes) is read from the persisted approval row, never trusted
 * from the client (a client cannot make one approval resolve a different run).
 *
 * Idempotency lives in SQLite: `flowApprovals.resolve` is a conditional update
 * that transitions only a `pending` row, so approving twice resolves once and
 * runs the workflow exactly once. Only the winning call triggers the resume.
 *
 * Human-only: this is invoked from the approval API on an explicit human action.
 * Nothing here (and nothing in the engine) ever auto-approves.
 */
import type { FounderDb } from '@/lib/db';
import type { FlowApproval } from '@/lib/flows/run-types';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { resumeRunBg } from '@/lib/flows/coordinator';

/** Actor recorded when the local operator resolves an approval (no auth layer exists yet). */
export const LOCAL_ACTOR = 'local_operator';

export type ResolveApprovalResult =
  | { ok: true; approval: FlowApproval; resumed: boolean }
  | { ok: false; code: 'not_found'; approval: null }
  | { ok: false; code: 'already_resolved'; approval: FlowApproval };

/**
 * Resolve an approval and, on success, resume its run in the background. A second
 * concurrent call (or a double-click) hits `already_resolved` and does nothing —
 * the run is never resumed twice.
 */
export function resolveApproval(
  db: FounderDb,
  approvalId: string,
  decision: 'approved' | 'rejected',
  opts?: { actor?: string; note?: string | null },
): ResolveApprovalResult {
  const existing = db.flowApprovals.get(approvalId);
  if (!existing) return { ok: false, code: 'not_found', approval: null };

  const actor = opts?.actor?.trim() || LOCAL_ACTOR;
  const note = opts?.note?.trim() ? opts.note.trim().slice(0, 2000) : null;

  const resolved = db.flowApprovals.resolve(approvalId, decision, actor, note);
  if (!resolved) {
    // Conditional update affected 0 rows → already resolved by a prior call.
    return { ok: false, code: 'already_resolved', approval: db.flowApprovals.get(approvalId)! };
  }

  const resumed = resumeRunBg(db, resolved.runId, allRuntimeAgents(db));
  return { ok: true, approval: resolved, resumed };
}
