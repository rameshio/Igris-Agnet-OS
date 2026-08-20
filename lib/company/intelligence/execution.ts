/**
 * Execution Intelligence analyzer (Architecture V2 · F6). Windowed completion /
 * failure counts, direct-agent vs workflow execution mix, defensible task
 * durations, workflow run success/failure, and the raw inputs for the
 * repeated-failure + workflow-failure-cluster signals. READ-ONLY.
 *
 * Duration rules (item 15): a duration is counted only when BOTH startedAt and
 * completedAt exist and the task actually completed — incomplete tasks are
 * excluded and durations are never fabricated. Median is preferred (outlier-robust).
 */
import type { FounderDb } from '@/lib/db';
import {
  completionRate,
  durationStats,
  inWindow,
  INTEL_THRESHOLDS,
  type ExecutionInsight,
  type RepeatedFailure,
  type WindowBounds,
  type WorkflowCluster,
} from '@/lib/company/intelligence/model';

const MAX_WINDOW_RUNS = 500;
const MAX_WINDOW_EVENTS = 500;

export type ExecutionResult = {
  insight: ExecutionInsight;
  workflowClusters: WorkflowCluster[];
  repeatedFailures: RepeatedFailure[];
};

export function buildExecutionHealth(db: FounderDb, w: WindowBounds): ExecutionResult {
  const tasks = db.companyTasks.all();

  let tasksCompleted = 0;
  let tasksFailed = 0;
  let directAgentExecutions = 0;
  let workflowExecutions = 0;
  let longRunningTasks = 0;
  const durations: number[] = [];

  for (const t of tasks) {
    if (t.status === 'completed' && inWindow(t.completedAt, w)) {
      tasksCompleted += 1;
      if (t.startedAt && t.completedAt) {
        const d = new Date(t.completedAt).getTime() - new Date(t.startedAt).getTime();
        if (Number.isFinite(d) && d >= 0) durations.push(d);
      }
    }
    if (t.status === 'failed' && inWindow(t.completedAt, w)) tasksFailed += 1;

    // How work was executed, within the window (startedAt marks dispatch).
    if (t.executionKind && inWindow(t.startedAt ?? t.updatedAt, w)) {
      if (t.executionKind === 'agent') directAgentExecutions += 1;
      else if (t.executionKind === 'workflow') workflowExecutions += 1;
    }

    if (t.status === 'running' && t.startedAt) {
      const age = w.toMs - new Date(t.startedAt).getTime();
      if (Number.isFinite(age) && age > INTEL_THRESHOLDS.longRunningTaskMs) longRunningTasks += 1;
    }
  }

  // Workflow runs within the window (bounded read, filtered by creation time).
  const windowedRuns = db.flowRuns.recent(MAX_WINDOW_RUNS).filter((r) => inWindow(r.createdAt, w));
  const workflowRunsSucceeded = windowedRuns.filter((r) => r.status === 'success').length;
  const workflowRunsFailed = windowedRuns.filter((r) => r.status === 'failed').length;

  const byWorkflow = new Map<string, { runs: number; failures: number }>();
  for (const r of windowedRuns) {
    const agg = byWorkflow.get(r.workflowId) ?? { runs: 0, failures: 0 };
    agg.runs += 1;
    if (r.status === 'failed') agg.failures += 1;
    byWorkflow.set(r.workflowId, agg);
  }
  const workflowClusters: WorkflowCluster[] = [...byWorkflow.entries()]
    .filter(([, agg]) => agg.runs >= INTEL_THRESHOLDS.workflowFailureClusterMinRuns && agg.failures / agg.runs >= INTEL_THRESHOLDS.workflowFailureClusterRate)
    .map(([workflowId, agg]) => ({ workflowId, name: db.flowWorkflows.get(workflowId)?.name ?? workflowId, runs: agg.runs, failures: agg.failures, rate: agg.failures / agg.runs }))
    .sort((a, b) => b.rate - a.rate || (a.workflowId < b.workflowId ? -1 : 1));

  // Repeated task failures within the window (from the append-only event ledger).
  const failEvents = db.companyEvents.since(w.fromIso, MAX_WINDOW_EVENTS).filter((e) => e.type === 'TASK_FAILED' && e.taskId);
  const failsPerTask = new Map<string, number>();
  for (const e of failEvents) failsPerTask.set(e.taskId!, (failsPerTask.get(e.taskId!) ?? 0) + 1);
  const repeatedFailures: RepeatedFailure[] = [...failsPerTask.entries()]
    .filter(([, n]) => n >= INTEL_THRESHOLDS.repeatedFailureCount)
    .map(([taskId, failures]) => {
      const task = db.companyTasks.get(taskId);
      return { taskId, title: task?.title ?? taskId, missionId: task?.missionId ?? '', failures };
    })
    .sort((a, b) => b.failures - a.failures || (a.taskId < b.taskId ? -1 : 1));

  const insight: ExecutionInsight = {
    tasksCompleted,
    tasksFailed,
    completionRate: completionRate(tasksCompleted, tasksFailed),
    directAgentExecutions,
    workflowExecutions,
    taskDuration: durationStats(durations),
    longRunningTasks,
    workflowRuns: windowedRuns.length,
    workflowRunsSucceeded,
    workflowRunsFailed,
    workflowFailureRate: windowedRuns.length === 0 ? null : Math.round((workflowRunsFailed / windowedRuns.length) * 100) / 100,
  };

  return { insight, workflowClusters, repeatedFailures };
}
