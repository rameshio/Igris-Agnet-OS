/**
 * Agent Intelligence analyzer (Architecture V2 · F6). Per-agent workload from
 * canonical company-task assignments + REAL presence — active assignments, recent
 * + windowed completion/failure counts, current presence. READ-ONLY.
 *
 * Deliberately HONEST (item 17): no "utilization %" (not measured), no performance
 * score, no "best employee" ranking. Overload is derived ONLY from an explicit
 * active-assignment count against a documented threshold — never inferred quality.
 */
import type { FounderDb } from '@/lib/db';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { buildAgentPresence } from '@/lib/agents/presence-service';
import { inWindow, type AgentInsight, type AgentPresenceState, type WindowBounds } from '@/lib/company/intelligence/model';

const ACTIVE_STATUSES = new Set(['assigned', 'running', 'waiting_dependency', 'waiting_approval']);

export function buildAgentHealth(db: FounderDb, w: WindowBounds): AgentInsight[] {
  const tasks = db.companyTasks.all();
  const agents = allRuntimeAgents(db);
  const presence = new Map<string, AgentPresenceState>(buildAgentPresence(db).map((p) => [p.agentId, p.state]));

  const rows: AgentInsight[] = agents.map((agent) => {
    const mine = tasks.filter((t) => t.assignedAgentId === agent.id);
    const activeAssignments = mine.filter((t) => ACTIVE_STATUSES.has(t.status)).length;
    const recentAssignments = mine.filter((t) => inWindow(t.updatedAt, w)).length;
    const completedTasks = mine.filter((t) => t.status === 'completed' && inWindow(t.completedAt, w)).length;
    const failedTasks = mine.filter((t) => t.status === 'failed' && inWindow(t.completedAt, w)).length;
    return {
      agentId: agent.id,
      name: agent.name,
      activeAssignments,
      recentAssignments,
      completedTasks,
      failedTasks,
      currentPresence: presence.get(agent.id) ?? 'idle',
    };
  });

  // Keep it operational: only agents with a real relationship to company work or a live state.
  return rows
    .filter((r) => r.activeAssignments > 0 || r.recentAssignments > 0 || r.completedTasks > 0 || r.failedTasks > 0 || r.currentPresence !== 'idle')
    .sort((a, b) => b.activeAssignments - a.activeAssignments || b.recentAssignments - a.recentAssignments || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
