/**
 * Stale-running recovery (Reliability Phase G2).
 *
 * Fills the gap G1 left open: an AGENT-backed Company Task can be left `running`
 * forever when the app/process dies mid-dispatch (agent dispatch is synchronous +
 * in-process, so nothing reconciles it after a restart — unlike workflow tasks,
 * which the flow coordinator already reconciles via `reconcileTask`).
 *
 * This is a bounded, deterministic RECONCILIATION — not a scheduler, not a loop,
 * not a heartbeat. It is invoked once per `managerStep`, BEFORE the G1 retry pass.
 *
 * Stale-running rule (deterministic evidence, never a wall-clock guess):
 *   task.status === 'running'
 *   AND task.executionKind !== 'workflow'          (workflow tasks: reconcileTask owns them)
 *   AND NOT isAgentTaskActive(task.id)             (no live in-process dispatch — see delegation)
 * After a process restart the in-memory active set is empty, so every running agent
 * task is provably stale; a genuinely in-flight dispatch is protected because its id
 * is in the active set for the whole synchronous run.
 *
 * Recovery decision by side-effect safety (reusing the G1 `isTaskAutoRetrySafe` heuristic):
 *   - SAFE / idempotent   → code `execution_interrupted` (class EXECUTION_INTERRUPTED,
 *                            retryable) → the G1 retry pass may auto/explicit-retry it.
 *   - UNSAFE / uncertain  → code `execution_interrupted_review` (class
 *                            INTERRUPTED_REVIEW_REQUIRED, human action) → NEVER auto- or
 *                            one-click-retried; the operator must decide.
 *
 * Attempt semantics: recovery marks the ALREADY-COUNTED attempt interrupted — it NEVER
 * increments, decrements, or resets `attemptCount`, and never bypasses `max_attempts`.
 * It never creates an artifact, never dispatches, and (because it moves the task out of
 * `running`) never re-recovers the same task or re-emits its interruption event.
 */
import type { FounderDb } from '@/lib/db';
import type { CompanyTask } from '@/lib/company/model';
import { updateCompanyTask } from '@/lib/company/service';
import { appendEvent } from '@/lib/company/manager/events';
import { recordTaskFailure, isTaskAutoRetrySafe } from '@/lib/company/manager/retry';
import { isAgentTaskActive } from '@/lib/company/manager/delegation';

export const INTERRUPTION_CODE = 'execution_interrupted';
export const INTERRUPTION_REVIEW_CODE = 'execution_interrupted_review';

export type RecoveryOutcome =
  | { taskId: string; state: 'ACTIVE' } // a live in-process dispatch — left untouched
  | { taskId: string; state: 'RECOVERED_INTERRUPTED' } // safe → interrupted, retry-eligible
  | { taskId: string; state: 'RECOVERED_REVIEW_REQUIRED' }; // unsafe → interrupted, human review

/** Is this a running task G2 recovery owns? (agent-backed; workflow tasks are reconcileTask's.) */
function isRecoverableAgentTask(t: CompanyTask): boolean {
  return t.status === 'running' && t.executionKind !== 'workflow';
}

/**
 * Reconcile stale-running AGENT tasks in one mission. Bounded, idempotent, side-effect-safe.
 * Returns one outcome per running agent-backed task (ACTIVE ones are reported, not touched).
 */
export function recoverStaleRunningTasks(db: FounderDb, missionId: string): RecoveryOutcome[] {
  const outcomes: RecoveryOutcome[] = [];
  for (const t of db.companyTasks.forMission(missionId)) {
    if (!isRecoverableAgentTask(t)) continue;

    // A live, in-process dispatch is NOT stale — never recover it.
    if (isAgentTaskActive(t.id)) {
      outcomes.push({ taskId: t.id, state: 'ACTIVE' });
      continue;
    }

    const safe = isTaskAutoRetrySafe(db, t);
    const code = safe ? INTERRUPTION_CODE : INTERRUPTION_REVIEW_CODE;
    const attempt = t.attemptCount ?? 0;

    // running → failed (guarded transition), then stamp interruption metadata. `recordTaskFailure`
    // does NOT change attemptCount, so the already-started attempt is preserved as interrupted.
    updateCompanyTask(db, t.id, { status: 'failed' });
    const rec = recordTaskFailure(db, t.id, {
      code,
      summary: safe
        ? 'Execution interrupted before completion (process restart). No side effect expected — safe to retry.'
        : 'Execution interrupted before completion (process restart). A prior external action may have completed — manual review required.',
    });
    appendEvent(db, {
      type: 'TASK_EXECUTION_INTERRUPTED',
      missionId,
      taskId: t.id,
      agentId: t.assignedAgentId,
      summary: safe
        ? `Recovered interrupted task (attempt ${attempt}/${t.maxAttempts ?? 3}) — retry-eligible`
        : `Recovered interrupted task (attempt ${attempt}/${t.maxAttempts ?? 3}) — review required (possible side effect)`,
      metadata: { code, class: rec?.decision.class ?? null, attempt, maxAttempts: t.maxAttempts ?? 3, safe },
    });

    outcomes.push({ taskId: t.id, state: safe ? 'RECOVERED_INTERRUPTED' : 'RECOVERED_REVIEW_REQUIRED' });
  }
  return outcomes;
}
