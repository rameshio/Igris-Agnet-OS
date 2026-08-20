/**
 * Mission cleanup (Architecture V2 · G-Brain consolidation) — a SAFE seam for
 * removing test/trial data created during development. Two lifecycle-safe actions:
 *
 *   • archiveMission     — set status `archived` (hidden from the default view;
 *                          keeps EVERYTHING, provenance intact). Reversible-in-spirit,
 *                          the preferred action when history/audit matters.
 *   • deleteTestMission  — hard-delete a mission and ONLY its OWNED records (tasks,
 *                          dependencies, artifacts, events, proposals) after an
 *                          explicit preview → confirm. Temporary mission-bound agents
 *                          are RETIRED (disabled + unassigned), never hard-deleted.
 *
 * NEVER touches SHARED canonical objects: permanent/built-in agents, reusable
 * workflows, and durable promoted G-Brain knowledge all SURVIVE a mission delete
 * (a test mission going away must not destroy knowledge that outlived it). There is
 * NO generic/global wipe here — everything is scoped to one mission id, previewed,
 * and server-authoritative (ownership verified against the mission's own rows).
 */
import type { FounderDb } from '@/lib/db';
import { getMission, CompanyError } from '@/lib/company/service';
import { retireTemporaryAgents } from '@/lib/company/factory/service';
import { allRuntimeAgents } from '@/lib/agents/registry';
import type { Mission } from '@/lib/company/model';

export type CleanupCounts = { tasks: number; dependencies: number; artifacts: number; events: number; proposals: number };

export type MissionCleanupPreview = {
  missionId: string;
  title: string;
  status: Mission['status'];
  /** What a delete WOULD remove — mission-owned records only. */
  willDelete: CleanupCounts;
  /** Temporary, mission-bound factory agents that would be RETIRED (disabled), not deleted. */
  temporaryAgentsToRetire: { id: string; name: string }[];
  /** Explicitly PRESERVED — a mission delete never touches these. */
  preserved: {
    sharedAgents: { id: string; name: string }[];
    workflows: string[];
    durableKnowledgeUntouched: number;
  };
};

/** Distinct event ids owned by a mission (by mission_id OR by one of its task ids). */
function missionEventIds(db: FounderDb, missionId: string, taskIds: string[]): Set<string> {
  const ids = new Set<string>();
  for (const e of db.companyEvents.forMission(missionId, 2000)) ids.add(e.id);
  for (const t of taskIds) for (const e of db.companyEvents.forTask(t, 500)) ids.add(e.id);
  return ids;
}

/** Read-only: exactly what a delete would remove vs preserve. Never mutates. */
export function previewMissionCleanup(db: FounderDb, missionId: string): MissionCleanupPreview {
  const mission = getMission(db, missionId);
  if (!mission) throw new CompanyError('mission not found', 404);

  const tasks = db.companyTasks.forMission(missionId);
  const taskIds = tasks.map((t) => t.id);
  const deps = db.companyTaskDeps.forMission(missionId);
  const artifacts = db.companyArtifacts.forMission(missionId);
  const proposals = db.companyAgentProposals.forMission(missionId);
  const events = missionEventIds(db, missionId, taskIds);

  const agentName = new Map(allRuntimeAgents(db).map((a) => [a.id, a.name]));

  // Temporary mission-bound agents (from promoted proposals) → retired, not deleted.
  const tempAgentIds = new Set<string>();
  const temporaryAgentsToRetire: { id: string; name: string }[] = [];
  for (const p of proposals) {
    if (p.status === 'approved' && p.temporary && p.agentId) {
      tempAgentIds.add(p.agentId);
      temporaryAgentsToRetire.push({ id: p.agentId, name: agentName.get(p.agentId) ?? p.agentId });
    }
  }

  // Any OTHER agent assigned to a task is SHARED — preserved untouched.
  const sharedAgents: { id: string; name: string }[] = [];
  const seenShared = new Set<string>();
  for (const t of tasks) {
    const a = t.assignedAgentId;
    if (a && !tempAgentIds.has(a) && !seenShared.has(a)) {
      seenShared.add(a);
      sharedAgents.push({ id: a, name: agentName.get(a) ?? a });
    }
  }

  const workflows = [...new Set(tasks.map((t) => t.workflowId).filter((w): w is string => !!w))];

  return {
    missionId,
    title: mission.title,
    status: mission.status,
    willDelete: { tasks: tasks.length, dependencies: deps.length, artifacts: artifacts.length, events: events.size, proposals: proposals.length },
    temporaryAgentsToRetire,
    preserved: { sharedAgents, workflows, durableKnowledgeUntouched: db.brainKnowledge.all().length },
  };
}

/**
 * Lifecycle-safe archive — hide from the default view, keep everything. Archiving is a
 * DIRECT status write (not a normal transition) so it works from ANY state, including
 * completed/failed/cancelled — those stay terminal in the transition graph.
 */
export function archiveMission(db: FounderDb, missionId: string): Mission {
  const m = getMission(db, missionId);
  if (!m) throw new CompanyError('mission not found', 404);
  if (m.status === 'archived') return m;
  const archived: Mission = { ...m, status: 'archived', updatedAt: new Date().toISOString() };
  db.companyMissions.insert(archived);
  return archived;
}

/**
 * DESTRUCTIVE test-data delete — requires an explicit confirm. Cascades ONLY the
 * mission's owned records; retires (never deletes) temporary agents; leaves shared
 * agents, workflows, and durable knowledge intact. Returns the preview of what was removed.
 */
export function deleteTestMission(db: FounderDb, missionId: string, opts: { confirm: boolean }): { deleted: MissionCleanupPreview } {
  const mission = getMission(db, missionId);
  if (!mission) throw new CompanyError('mission not found', 404);
  if (!opts.confirm) throw new CompanyError('delete requires explicit confirmation', 400);

  const preview = previewMissionCleanup(db, missionId);
  const taskIds = db.companyTasks.forMission(missionId).map((t) => t.id);

  // Archive first so the mission is terminal, then retire its temporary agents (reversible).
  archiveMission(db, missionId);
  retireTemporaryAgents(db, missionId);

  // Cascade delete owned records — dependencies → events → artifacts → proposals → tasks → mission.
  db.companyTaskDeps.deleteForMission(missionId);
  db.companyEvents.deleteForMission(missionId, taskIds);
  db.companyArtifacts.deleteForMission(missionId);
  db.companyAgentProposals.deleteForMission(missionId);
  db.companyTasks.deleteForMission(missionId);
  db.companyMissions.delete(missionId);

  return { deleted: preview };
}
