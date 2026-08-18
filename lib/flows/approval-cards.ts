/**
 * Approval Decision Cards aggregator (UX Foundation U5, Part A) — the impure
 * boundary that reads authoritative Phase-E approval rows and hands the pure
 * model (lib/flows/approval-view.ts) a SAFE subset (never context_json) plus the
 * downstream classification it needs for risk.
 *
 * It creates NO persisted state and reuses existing repos only:
 *   flowApprovals.pending / .recent  →  the rows
 *   flowVersions.get                 →  immutable graph for downstream/risk
 *   flowWorkflows.get                →  display name
 *
 * Bounded: one bounded query per source; the version graph is loaded once per
 * (workflow@version) and cached across the build (mirrors the U4 Activity service).
 */
import type { FounderDb } from '@/lib/db';
import type { WorkflowGraph } from '@/lib/flows/schema';
import {
  buildApprovalDecisionView,
  classifyDownstream,
  type ApprovalDecisionView,
  type ApprovalViewInput,
} from '@/lib/flows/approval-view';

export type ApprovalCards = {
  pending: ApprovalDecisionView[];
  resolved: ApprovalDecisionView[];
};

/** Statuses that count as resolved history (inspectable, actions disabled). */
const RESOLVED_STATUSES = new Set(['approved', 'rejected', 'expired', 'cancelled']);

export function buildApprovalCards(
  db: FounderDb,
  opts: { pendingLimit?: number; resolvedLimit?: number } = {},
): ApprovalCards {
  const pendingLimit = Math.min(Math.max(opts.pendingLimit ?? 100, 1), 200);
  const resolvedLimit = Math.min(Math.max(opts.resolvedLimit ?? 40, 0), 200);

  // ── Caches (avoid repeated lookups across the build) ──
  const wfNameCache = new Map<string, string | undefined>();
  const workflowName = (id: string): string | undefined => {
    if (!wfNameCache.has(id)) wfNameCache.set(id, db.flowWorkflows.get(id)?.name);
    return wfNameCache.get(id);
  };

  const graphCache = new Map<string, WorkflowGraph | null>();
  const versionGraph = (workflowId: string, version: number): WorkflowGraph | null => {
    const key = `${workflowId}@${version}`;
    if (!graphCache.has(key)) graphCache.set(key, db.flowVersions.get(workflowId, version)?.graph ?? null);
    return graphCache.get(key) ?? null;
  };

  const toView = (a: ApprovalViewInput): ApprovalDecisionView => {
    const graph = versionGraph(a.workflowId, a.workflowVersion);
    const downstream = classifyDownstream(graph, a.nodeId, a.approvalRoute);
    return buildApprovalDecisionView(a, { workflowName: workflowName(a.workflowId), downstream });
  };

  const pending = db.flowApprovals.pending(pendingLimit).map(toView);

  const resolved =
    resolvedLimit === 0
      ? []
      : db.flowApprovals
          .recent(resolvedLimit * 2)
          .filter((a) => RESOLVED_STATUSES.has(a.status))
          .slice(0, resolvedLimit)
          .map(toView);

  return { pending, resolved };
}
