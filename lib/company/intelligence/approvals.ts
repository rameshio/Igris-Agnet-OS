/**
 * Approval Intelligence analyzer (Architecture V2 · F6). Pending backlog, oldest
 * wait, in-window resolution throughput + average wait, and the tasks currently
 * blocked on a human gate. READ-ONLY and PRIVACY-SAFE: it reads only safe fields
 * (id, title, timings) — NEVER the approval `context_json`, message body, or any
 * raw input. No approval is ever resolved from Intelligence (navigation only).
 */
import type { FounderDb } from '@/lib/db';
import { inWindow, INTEL_THRESHOLDS, type ApprovalInsight, type DelayedApproval, type WindowBounds } from '@/lib/company/intelligence/model';

const MAX_PENDING = 200;
const MAX_RECENT = 200;

export type ApprovalResult = { insight: ApprovalInsight; delayedApprovals: DelayedApproval[] };

export function buildApprovalHealth(db: FounderDb, w: WindowBounds): ApprovalResult {
  const now = w.toMs;

  // Map workflow runs → the company task that dispatched them (for evidence links).
  const taskForRun = new Map<string, { taskId: string; missionId: string }>();
  for (const t of db.companyTasks.all()) {
    if (t.executionKind === 'workflow' && t.executionRefId) taskForRun.set(t.executionRefId, { taskId: t.id, missionId: t.missionId });
  }

  const pending = db.flowApprovals.pending(MAX_PENDING);
  let oldestPendingAgeMs: number | null = null;
  const delayedApprovals: DelayedApproval[] = [];
  for (const a of pending) {
    const waitMs = now - new Date(a.requestedAt).getTime();
    if (!Number.isFinite(waitMs) || waitMs < 0) continue;
    if (oldestPendingAgeMs === null || waitMs > oldestPendingAgeMs) oldestPendingAgeMs = waitMs;
    if (waitMs > INTEL_THRESHOLDS.longApprovalWaitMs) {
      const link = taskForRun.get(a.runId);
      delayedApprovals.push({ approvalId: a.id, title: a.title, taskId: link?.taskId, missionId: link?.missionId, waitMs });
    }
  }
  delayedApprovals.sort((a, b) => b.waitMs - a.waitMs || (a.approvalId < b.approvalId ? -1 : 1));

  // In-window resolutions (resolved_at bumps updated_at, so `recent` surfaces them).
  const resolved = db.flowApprovals
    .recent(MAX_RECENT)
    .filter((a) => (a.status === 'approved' || a.status === 'rejected') && inWindow(a.resolvedAt, w) && a.resolvedAt);
  const waits = resolved
    .map((a) => new Date(a.resolvedAt!).getTime() - new Date(a.requestedAt).getTime())
    .filter((d) => Number.isFinite(d) && d >= 0);
  const averageResolvedWaitMs = waits.length === 0 ? null : Math.round(waits.reduce((s, d) => s + d, 0) / waits.length);

  const tasksWaitingApproval = db.companyTasks.all().filter((t) => t.status === 'waiting_approval').length;

  return {
    insight: {
      pending: pending.length,
      oldestPendingAgeMs,
      resolvedInWindow: resolved.length,
      averageResolvedWaitMs,
      tasksWaitingApproval,
    },
    delayedApprovals,
  };
}
