/**
 * Work Health analyzer (Architecture V2 · F6) — the current queue + windowed
 * throughput + stale-work detection over Company Missions/Tasks. READ-ONLY:
 * reads canonical rows, computes counts/timings, mutates nothing.
 *
 * Current-state metrics (queue depth, blocked missions) reflect NOW; windowed
 * metrics (completed/failed) are bounded to the analysis window. Stale detection
 * uses task timestamps + centralized thresholds — never event guesswork, and a
 * completed/cancelled task is never labeled stale.
 */
import type { FounderDb } from '@/lib/db';
import type { CompanyTask, Mission } from '@/lib/company/model';
import {
  inWindow,
  staleThresholdForStatus,
  type MissionHealthRow,
  type StaleTask,
  type WindowBounds,
  type WorkHealthInsight,
} from '@/lib/company/intelligence/model';

function missionRow(mission: Mission, tasks: CompanyTask[]): MissionHealthRow {
  const nonCancelled = tasks.filter((t) => t.status !== 'cancelled');
  const completed = nonCancelled.filter((t) => t.status === 'completed').length;
  const failed = nonCancelled.filter((t) => t.status === 'failed').length;
  const total = nonCancelled.length;
  return {
    missionId: mission.id,
    title: mission.title,
    status: mission.status,
    total,
    completed,
    failed,
    progress: total === 0 ? 0 : Math.round((completed / total) * 100) / 100,
  };
}

export function buildWorkHealth(db: FounderDb, w: WindowBounds): WorkHealthInsight {
  const tasks = db.companyTasks.all();
  const missions = db.companyMissions.all();
  const tasksByMission = new Map<string, CompanyTask[]>();
  for (const t of tasks) (tasksByMission.get(t.missionId) ?? tasksByMission.set(t.missionId, []).get(t.missionId)!).push(t);

  let queued = 0;
  let assigned = 0;
  let running = 0;
  let waitingDependency = 0;
  let waitingApproval = 0;
  let completedInWindow = 0;
  let failedInWindow = 0;
  const staleTasks: StaleTask[] = [];

  for (const t of tasks) {
    switch (t.status) {
      case 'queued':
        queued += 1;
        break;
      case 'assigned':
        assigned += 1;
        break;
      case 'running':
        running += 1;
        break;
      case 'waiting_dependency':
        waitingDependency += 1;
        break;
      case 'waiting_approval':
        waitingApproval += 1;
        break;
      case 'completed':
        if (inWindow(t.completedAt, w)) completedInWindow += 1;
        break;
      case 'failed':
        if (inWindow(t.completedAt, w)) failedInWindow += 1;
        break;
      default:
        break;
    }

    const threshold = staleThresholdForStatus(t.status);
    if (threshold !== null) {
      const ageMs = w.toMs - new Date(t.updatedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs > threshold) {
        staleTasks.push({ taskId: t.id, title: t.title, missionId: t.missionId, status: t.status, ageMs, thresholdMs: threshold });
      }
    }
  }
  staleTasks.sort((a, b) => b.ageMs - a.ageMs || (a.taskId < b.taskId ? -1 : 1));

  const missionRows = missions.map((m) => missionRow(m, tasksByMission.get(m.id) ?? []));

  return {
    queued,
    assigned,
    running,
    waitingDependency,
    waitingApproval,
    completedInWindow,
    failedInWindow,
    activeMissions: missions.filter((m) => m.status === 'active').length,
    blockedMissions: missions.filter((m) => m.status === 'blocked').length,
    missionsWithFailures: missionRows.filter((m) => m.failed > 0).length,
    completedMissionsInWindow: missions.filter((m) => m.status === 'completed' && inWindow(m.completedAt, w)).length,
    staleTasks,
    missions: missionRows,
  };
}
