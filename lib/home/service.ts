/**
 * Commander Home aggregator (UX Foundation U6) — the impure boundary that COMPOSES
 * the existing read-only services into one bounded `HomeSnapshot`. It duplicates
 * no business logic and creates no persisted state:
 *
 *   U5 buildApprovalCards      → pending approvals (safe projection)
 *   U4 buildActivityFeed       → recent operational events
 *   flowRuns repo              → running + failed-in-window + active counts
 *   allRuntimeAgents           → agent count
 *   meta KV (cheap)            → Hermes status (NEVER probes the binary)
 *
 * One page load / poll = one call here = a handful of bounded queries. Read-only.
 */
import type { FounderDb } from '@/lib/db';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { buildActivityFeed } from '@/lib/activity/service';
import { buildApprovalCards } from '@/lib/flows/approval-cards';
import { activeLlmProviderName } from '@/lib/connectors/llm';
import {
  homeHermesStatus,
  isFirstRun,
  HOME_NEEDS_YOU_CAP,
  HOME_RUNNING_CAP,
  HOME_RECENT_CAP,
  HOME_RECENT_FAILURE_MS,
  type HomeApprovalItem,
  type HomeAttentionItem,
  type HomeRunItem,
  type HomeSnapshot,
  type HomeSystemStatus,
} from '@/lib/home/model';

/** Bounded scan of recent runs — enough to find active + recently-failed without reading history. */
const RUN_SCAN = 60;

export function buildHomeSnapshot(db: FounderDb, opts: { now?: number } = {}): HomeSnapshot {
  const nowMs = opts.now ?? Date.now();

  const wfNameCache = new Map<string, string | undefined>();
  const workflowName = (id: string): string | undefined => {
    if (!wfNameCache.has(id)) wfNameCache.set(id, db.flowWorkflows.get(id)?.name);
    return wfNameCache.get(id);
  };

  // ── Pending approvals (U5 safe projection — no context_json) ──
  const cards = buildApprovalCards(db, { resolvedLimit: 0 });
  const pendingApprovals: HomeApprovalItem[] = cards.pending.slice(0, HOME_NEEDS_YOU_CAP).map((a) => ({
    approvalId: a.approvalId,
    title: a.title,
    workflowId: a.workflowId,
    workflowName: a.workflowName,
    runId: a.runId,
    risk: a.risk,
  }));

  // ── Runs: partition a bounded recent scan into running / waiting / recent-failed ──
  const recentRuns = db.flowRuns.recent(RUN_SCAN);
  const running: HomeRunItem[] = recentRuns
    .filter((r) => r.status === 'running')
    .slice(0, HOME_RUNNING_CAP)
    .map((r) => ({ runId: r.id, workflowId: r.workflowId, workflowName: workflowName(r.workflowId), status: r.status, startedAt: r.startedAt }));

  const waitingCount = recentRuns.filter((r) => r.status === 'waiting_approval').length;
  const runningCount = recentRuns.filter((r) => r.status === 'running').length;

  const recentFailedRuns = recentRuns.filter((r) => {
    if (r.status !== 'failed') return false;
    const ended = r.endedAt ?? r.updatedAt;
    const t = Date.parse(ended);
    return !Number.isNaN(t) && nowMs - t <= HOME_RECENT_FAILURE_MS;
  });
  const attention: HomeAttentionItem[] = recentFailedRuns.slice(0, HOME_NEEDS_YOU_CAP).map((r) => ({
    kind: 'run_failed',
    runId: r.id,
    workflowId: r.workflowId,
    workflowName: workflowName(r.workflowId),
    at: r.endedAt ?? r.updatedAt,
    // errorCode is a short operator label (never a payload); errorMessage is truncated upstream in the engine.
    detail: r.errorCode ?? undefined,
  }));

  // ── Recent (reuse U4 Activity — same normalized events, no new table) ──
  const recent = buildActivityFeed(db, { limit: HOME_RECENT_CAP });

  // ── System status ──
  const provider = activeLlmProviderName();
  const transport = db.meta.get('hermes_production_transport');
  const hermes = homeHermesStatus({
    provider,
    transport,
    lastCheckAt: db.meta.get('hermes_runtime_last_check'),
    lastSuccessAt: db.meta.get('hermes_runtime_last_success'),
  });

  const system: HomeSystemStatus = {
    hermes,
    agentCount: allRuntimeAgents(db).length,
    activeRunCount: runningCount + waitingCount,
    pendingApprovalCount: cards.pending.length,
    recentFailureCount: recentFailedRuns.length,
  };

  const firstRun = isFirstRun({
    workflows: db.flowWorkflows.all().length,
    customAgents: db.customAgents.all().length,
    runs: recentRuns.length,
  });

  return { pendingApprovals, attention, running, recent, system, firstRun, generatedAt: new Date(nowMs).toISOString() };
}
