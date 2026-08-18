/**
 * Agent Presence aggregator (UX Foundation U5, Part B) — the impure boundary that
 * reads authoritative run / node-run / approval rows and extracts pure
 * `PresenceSignal`s for the model (lib/agents/presence.ts) to reduce.
 *
 * Signals (all derived from REAL state — nothing fabricated):
 *   working          ← an AGENT node-run currently `running`
 *   waiting_approval ← a PENDING approval on a run the agent actually participated
 *                      in (it has an agent node-run in that run — never guessed)
 *   failed           ← an AGENT node-run that `failed`
 *
 * Agent identity is resolved AUTHORITATIVELY (node run → its run's immutable
 * version graph → the agent node's configured agentId), cached per version — the
 * same resolution the U4 Activity stream uses. When identity cannot be resolved,
 * no signal is emitted (the relationship is not guessed).
 *
 * Bounded: one bounded query per source + `forRun` per (few) pending approvals.
 * Read-only: creates no persisted state.
 */
import type { FounderDb } from '@/lib/db';
import type { WorkflowGraph } from '@/lib/flows/schema';
import { reduceAllPresence, type AgentPresence, type PresenceSignal } from '@/lib/agents/presence';

export function buildAgentPresence(
  db: FounderDb,
  opts: { limit?: number; now?: number } = {},
): AgentPresence[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const nowMs = opts.now ?? Date.now();

  // node_id → agentId, keyed by `${workflowId}@${version}` (version graph loaded once).
  const graphAgentCache = new Map<string, Map<string, string>>();
  const agentIdForNode = (workflowId: string, version: number, nodeId: string): string | undefined => {
    const key = `${workflowId}@${version}`;
    let map = graphAgentCache.get(key);
    if (!map) {
      map = new Map<string, string>();
      const snapshot: { graph: WorkflowGraph } | null = db.flowVersions.get(workflowId, version);
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

  const runCache = new Map<string, { workflowId: string; workflowVersion: number } | null>();
  const runMeta = (runId: string): { workflowId: string; workflowVersion: number } | null => {
    if (!runCache.has(runId)) {
      const r = db.flowRuns.get(runId);
      runCache.set(runId, r ? { workflowId: r.workflowId, workflowVersion: r.workflowVersion } : null);
    }
    return runCache.get(runId) ?? null;
  };

  const wfNameCache = new Map<string, string | undefined>();
  const workflowName = (id: string): string | undefined => {
    if (!wfNameCache.has(id)) wfNameCache.set(id, db.flowWorkflows.get(id)?.name);
    return wfNameCache.get(id);
  };

  const signals: PresenceSignal[] = [];

  // ── working / failed from agent node-runs ──
  for (const n of db.flowNodeRuns.recent(limit)) {
    if (n.nodeType !== 'agent') continue;
    if (n.status !== 'running' && n.status !== 'failed') continue;
    const meta = runMeta(n.runId);
    if (!meta) continue;
    const agentId = agentIdForNode(meta.workflowId, meta.workflowVersion, n.nodeId);
    if (!agentId) continue; // identity not resolvable → do not guess
    signals.push({
      kind: n.status === 'running' ? 'working' : 'failed',
      agentId,
      at: (n.status === 'running' ? n.startedAt : n.endedAt) ?? n.startedAt ?? n.createdAt,
      workflowId: meta.workflowId,
      workflowName: workflowName(meta.workflowId),
      runId: n.runId,
    });
  }

  // ── waiting_approval: agents that participated in a run now paused on a gate ──
  for (const appr of db.flowApprovals.pending(100)) {
    const meta = runMeta(appr.runId) ?? { workflowId: appr.workflowId, workflowVersion: appr.workflowVersion };
    const seen = new Set<string>();
    for (const n of db.flowNodeRuns.forRun(appr.runId)) {
      if (n.nodeType !== 'agent') continue;
      const agentId = agentIdForNode(meta.workflowId, meta.workflowVersion, n.nodeId);
      if (!agentId || seen.has(agentId)) continue;
      seen.add(agentId);
      signals.push({
        kind: 'waiting_approval',
        agentId,
        at: appr.requestedAt,
        workflowId: meta.workflowId,
        workflowName: workflowName(meta.workflowId),
        runId: appr.runId,
      });
    }
  }

  return reduceAllPresence(signals, nowMs);
}
