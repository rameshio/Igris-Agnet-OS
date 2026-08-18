/**
 * IGRIS Activity aggregator (UX Foundation U4) — the impure boundary that reads
 * authoritative run/approval/node-run rows from the repositories and hands the
 * pure model (lib/activity/model.ts) small, sanitized `*Lite` shapes. It creates
 * NO new persisted state: the Activity stream is a read-only projection.
 *
 * Data flow:  repositories → buildActivityFeed → pure builders → bounded feed.
 *
 * Agent identity is resolved AUTHORITATIVELY (node run → its run's immutable
 * version graph → the agent node's configured agentId → the runtime agent's
 * name), cached per version/agent. When it cannot be resolved reliably, the
 * event is kept as a workflow/node event rather than guessing an agent.
 */
import type { FounderDb } from '@/lib/db';
import { allRuntimeAgents } from '@/lib/agents/registry';
import {
  buildFeed,
  eventsForApproval,
  eventsForNodeRun,
  eventsForRun,
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  type ActivityEvent,
  type ActivityFilter,
  type ApprovalLite,
  type NodeRunLite,
  type RunLite,
} from '@/lib/activity/model';

export type ActivityFeedOptions = { limit?: number; filter?: ActivityFilter };

/**
 * Build the bounded Activity feed. One bounded query per source + in-memory
 * merge — cheap at current scale (see docs/ARCHITECTURE.md for the scaling note).
 */
export function buildActivityFeed(db: FounderDb, opts: ActivityFeedOptions = {}): ActivityEvent[] {
  const limit = Math.min(Math.max(opts.limit ?? ACTIVITY_DEFAULT_LIMIT, 1), ACTIVITY_MAX_LIMIT);
  // Over-fetch a little per source (each row can yield up to ~2 events, and we
  // then sort + cap) — still bounded, never the whole history.
  const perSource = Math.min(limit * 2, ACTIVITY_MAX_LIMIT);

  const runs = db.flowRuns.recent(perSource);
  const approvals = db.flowApprovals.recent(perSource);
  const nodeRuns = db.flowNodeRuns.recent(perSource);

  // ── Caches (avoid N repeated lookups across the merge) ──
  const wfNameCache = new Map<string, string | undefined>();
  const workflowName = (id: string): string | undefined => {
    if (!wfNameCache.has(id)) wfNameCache.set(id, db.flowWorkflows.get(id)?.name);
    return wfNameCache.get(id);
  };

  const agentNames = new Map<string, string>();
  for (const a of allRuntimeAgents(db)) agentNames.set(a.id, a.name);

  const runCache = new Map<string, { workflowId: string; workflowVersion: number } | null>();
  const runMeta = (runId: string): { workflowId: string; workflowVersion: number } | null => {
    if (!runCache.has(runId)) {
      const r = db.flowRuns.get(runId);
      runCache.set(runId, r ? { workflowId: r.workflowId, workflowVersion: r.workflowVersion } : null);
    }
    return runCache.get(runId) ?? null;
  };

  // node_id → agentId, keyed by `${workflowId}@${version}` (loads the version graph once).
  const graphAgentCache = new Map<string, Map<string, string>>();
  const agentIdForNode = (workflowId: string, version: number, nodeId: string): string | undefined => {
    const key = `${workflowId}@${version}`;
    let map = graphAgentCache.get(key);
    if (!map) {
      map = new Map<string, string>();
      const snapshot = db.flowVersions.get(workflowId, version);
      for (const node of snapshot?.graph.nodes ?? []) {
        if (node.type === 'agent') {
          const agentId = (node.config as { agentId?: string } | undefined)?.agentId;
          if (agentId) map.set(node.id, agentId);
        }
      }
      graphAgentCache.set(key, map);
    }
    return map.get(nodeId);
  };

  const events: ActivityEvent[] = [];

  for (const r of runs) {
    const lite: RunLite = {
      id: r.id,
      workflowId: r.workflowId,
      workflowName: workflowName(r.workflowId),
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
    };
    events.push(...eventsForRun(lite));
  }

  for (const a of approvals) {
    const lite: ApprovalLite = {
      id: a.id,
      runId: a.runId,
      workflowId: a.workflowId,
      workflowName: workflowName(a.workflowId),
      status: a.status,
      title: a.title,
      requestedAt: a.requestedAt,
      resolvedAt: a.resolvedAt,
    };
    events.push(...eventsForApproval(lite));
  }

  for (const n of nodeRuns) {
    // Only agent nodes and failures produce events; resolve identity for agent nodes.
    const meta = runMeta(n.runId);
    let agentId: string | undefined;
    if (n.nodeType === 'agent' && meta) agentId = agentIdForNode(meta.workflowId, meta.workflowVersion, n.nodeId);
    const lite: NodeRunLite = {
      id: n.id,
      runId: n.runId,
      workflowId: meta?.workflowId,
      workflowName: meta ? workflowName(meta.workflowId) : undefined,
      nodeId: n.nodeId,
      nodeType: n.nodeType,
      status: n.status,
      agentId,
      agentName: agentId ? agentNames.get(agentId) : undefined,
      startedAt: n.startedAt,
      endedAt: n.endedAt,
      createdAt: n.createdAt,
      errorMessage: n.errorMessage,
    };
    events.push(...eventsForNodeRun(lite));
  }

  return buildFeed(events, { filter: opts.filter, limit });
}
