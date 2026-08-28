/**
 * Executive Manager service (Architecture V2 · F1) — the bounded orchestration
 * step and the deterministic mission report.
 *
 * `managerStep` performs ONE small, bounded tick (no autonomous/infinite loop):
 *   reconcile running workflow tasks → promote satisfied waiting_dependency tasks →
 *   dispatch up to `maxSteps` actionable tasks → derive mission completion.
 * Everything is durable (canonical DB state + execution refs survive restart) and
 * uses the central F0.2 transition model — the Manager never bypasses it.
 *
 * `missionReport` is a DETERMINISTIC read model (exists with no LLM). An optional
 * grounded `managerSummary` can be synthesized separately; it never mutates state.
 */
import type { FounderDb } from '@/lib/db';
import { chat as llmChat } from '@/lib/connectors/llm';
import { CompanyError, getMission, updateMission, updateCompanyTask, listTasksForMission, getTaskDependencies } from '@/lib/company/service';
import { dispatchTask, reconcileTask, type DispatchResult } from '@/lib/company/manager/delegation';
import { promoteRetryableFailures } from '@/lib/company/manager/retry';
import { recoverStaleRunningTasks } from '@/lib/company/manager/recovery';
import { retireTemporaryAgents } from '@/lib/company/factory/service';
import { appendEvent } from '@/lib/company/manager/events';
import { safeArtifactSummary, deriveMissionComplete, type MissionReport, type MissionTaskCounts, type Blocker, type CapabilityGap } from '@/lib/company/manager/model';
import { resolveAgentsForCapabilities } from '@/lib/agents/registry';
import type { Mission } from '@/lib/company/model';

export const MANAGER_STEP_DEFAULT_MAX = 3;

export type ManagerStepResult = {
  mission: Mission;
  dispatched: DispatchResult[];
  report: MissionReport;
};

/**
 * One bounded orchestration tick. Returns the dispatched outcomes + a fresh report.
 * Deterministic where possible; dispatch order follows task creation order.
 */
export async function managerStep(db: FounderDb, missionId: string, opts: { maxSteps?: number } = {}): Promise<ManagerStepResult> {
  const mission = getMission(db, missionId);
  if (!mission) throw new CompanyError('mission not found', 404);
  const maxSteps = Math.max(1, Math.min(opts.maxSteps ?? MANAGER_STEP_DEFAULT_MAX, 10));

  // Activate a draft mission on first orchestration.
  if (mission.status === 'draft') updateMission(db, missionId, { status: 'active' });

  // 1. Reconcile running workflow tasks (durable sync from the flow runs).
  for (const t of listTasksForMission(db, missionId)) {
    if (t.status === 'running' && t.executionKind === 'workflow') reconcileTask(db, t.id);
  }

  // 1b. Reliability G2: recover stale-running AGENT tasks. Agent dispatch is synchronous +
  // in-process, so a task left `running` after a process restart is provably stale (its
  // in-memory active marker is gone). Recovery marks the interrupted attempt failed WITHOUT
  // incrementing attemptCount — a side-effect-safe task becomes retry-eligible (the G1 pass
  // below may auto-retry it), an unsafe one becomes review-required (never auto-retried).
  // Reconciliation runs BEFORE retry promotion and dispatch.
  recoverStaleRunningTasks(db, missionId);

  // 2. Promote waiting_dependency tasks whose prerequisites are now satisfied.
  for (const t of listTasksForMission(db, missionId)) {
    if (t.status === 'waiting_dependency' && getTaskDependencies(db, t.id).satisfied) {
      try {
        updateCompanyTask(db, t.id, { status: 'queued' }); // waiting_dependency → queued (transition-guarded)
      } catch {
        /* transition model rejected — leave as-is */
      }
    }
  }

  // 2b. Reliability G1: auto-retry AUTOMATICALLY-retryable failed tasks (transient
  // provider/timeout/rate-limit) with attempts remaining — controlled failed→queued,
  // so the dispatch loop below re-runs them. Non-retryable failures (missing config,
  // capability gap, invalid input, unknown) are NEVER auto-retried and never loop.
  promoteRetryableFailures(db, missionId);

  // 3. Dispatch the next actionable tasks, bounded by maxSteps.
  const dispatched: DispatchResult[] = [];
  for (const t of listTasksForMission(db, missionId)) {
    if (dispatched.length >= maxSteps) break;
    if ((t.status === 'queued' || t.status === 'assigned') && getTaskDependencies(db, t.id).satisfied) {
      const r = await dispatchTask(db, t.id);
      if (r.outcome === 'already_active' || r.outcome === 'waiting_dependency') continue;
      dispatched.push(r);
    }
  }

  // 4. Deterministic mission completion (never on partial success).
  const statuses = listTasksForMission(db, missionId).map((t) => t.status);
  const current = getMission(db, missionId)!;
  if (statuses.length > 0 && deriveMissionComplete(statuses) && current.status !== 'completed') {
    updateMission(db, missionId, { status: 'completed' });
    appendEvent(db, { type: 'MISSION_COMPLETED', missionId, summary: 'Mission completed' });
    // Retire any temporary F2 factory agents bound to this mission (bounded, one pass).
    retireTemporaryAgents(db, missionId);
  }

  return { mission: getMission(db, missionId)!, dispatched, report: missionReport(db, missionId) };
}

/** DETERMINISTIC mission report (no LLM). Blockers + capability gaps are derived from real task state. */
export function missionReport(db: FounderDb, missionId: string): MissionReport {
  const mission = getMission(db, missionId);
  if (!mission) throw new CompanyError('mission not found', 404);
  const tasks = listTasksForMission(db, missionId);

  const counts: MissionTaskCounts = { total: tasks.length, queued: 0, assigned: 0, running: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 };
  const blockers: Blocker[] = [];
  const capabilityGaps: CapabilityGap[] = [];

  for (const t of tasks) {
    switch (t.status) {
      case 'queued':
        counts.queued++;
        break;
      case 'assigned':
        counts.assigned++;
        break;
      case 'running':
        counts.running++;
        break;
      case 'waiting_dependency':
      case 'waiting_approval':
        counts.waiting++;
        break;
      case 'completed':
        counts.completed++;
        break;
      case 'failed':
        counts.failed++;
        break;
      case 'cancelled':
        counts.cancelled++;
        break;
    }

    if (t.status === 'failed') blockers.push({ taskId: t.id, title: t.title, reason: 'failed' });
    else if (t.status === 'waiting_approval') blockers.push({ taskId: t.id, title: t.title, reason: 'waiting_approval' });
    else if (t.status === 'waiting_dependency') blockers.push({ taskId: t.id, title: t.title, reason: 'waiting_dependency' });
    else if (t.status === 'queued' && t.requiredCapabilities.length > 0 && !t.assignedAgentId) {
      const hasWorkflow = !!(t.workflowId && db.flowWorkflows.get(t.workflowId)?.currentVersion != null);
      const eligible = resolveAgentsForCapabilities(db, t.requiredCapabilities, { mode: 'all' });
      if (!hasWorkflow && eligible.length === 0) {
        capabilityGaps.push({ taskId: t.id, title: t.title, requiredCapabilities: t.requiredCapabilities, missingCapabilities: t.requiredCapabilities, reason: 'capability_gap' });
        blockers.push({ taskId: t.id, title: t.title, reason: 'capability_gap', requiredCapabilities: t.requiredCapabilities, missingCapabilities: t.requiredCapabilities });
      }
    }
  }

  return {
    missionId,
    status: mission.status,
    taskCounts: counts,
    artifacts: db.companyArtifacts.forMission(missionId).map(safeArtifactSummary),
    blockers,
    capabilityGaps,
  };
}

/**
 * OPTIONAL grounded synthesis — a short natural-language summary of the mission
 * report. Grounded ONLY on the deterministic report (safe data); it NEVER mutates
 * canonical state, and a synthesis failure returns the deterministic report
 * unchanged (best-effort). Not used by default — callers opt in.
 */
export async function synthesizeMissionSummary(db: FounderDb, missionId: string): Promise<MissionReport> {
  const report = missionReport(db, missionId);
  try {
    const system = 'You are the IGRIS Executive Manager. Given the mission report JSON, write a 1–3 sentence status summary for the operator. Do not invent data.';
    const grounding = JSON.stringify({ status: report.status, taskCounts: report.taskCounts, blockers: report.blockers, capabilityGaps: report.capabilityGaps, artifacts: report.artifacts.map((a) => a.title) });
    const res = await llmChat({ system, messages: [{ role: 'user', content: grounding }] });
    return { ...report, managerSummary: res.text.trim().slice(0, 1000) };
  } catch {
    return report; // best-effort — synthesis never corrupts the deterministic report
  }
}
