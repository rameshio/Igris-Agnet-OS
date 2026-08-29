/**
 * Task retry / recovery service (Reliability Phase G1).
 *
 * The ONE place a failed Company Task may be moved back toward execution. Retry is
 * a COMPANY/manager-level decision — never buried in low-level runtime/model code,
 * and never a background daemon or autonomous loop. Two controlled entry points:
 *   - `promoteRetryableFailures` — called inside a bounded `managerStep`; moves
 *     AUTOMATICALLY-retryable failed tasks (transient provider/timeout/rate-limit)
 *     back to `queued`, so the existing dispatch loop re-runs them.
 *   - `retryTask` — an EXPLICIT human retry (API/CLI); allowed only for a retryable
 *     failure with attempts remaining. Rejects non-retryable failures with a reason.
 *
 * The `failed → queued` move is a DIRECT, guarded write here (mirroring the mission
 * `archived` direct-write) so the ordinary `updateCompanyTask` transition model keeps
 * `failed` terminal — an arbitrary API/UI caller can never revive a failed task.
 *
 * Attempt semantics: `attemptCount` counts execution attempts STARTED. It is bumped
 * exactly once per real dispatch (see `beginTaskAttempt`, called from delegation when
 * a task actually transitions to `running`) — never by eligibility, preview, planning,
 * approval-wait, or capability-gap detection.
 */
import type { FounderDb } from '@/lib/db';
import type { CompanyTask } from '@/lib/company/model';
import { getCompanyTask, CompanyError } from '@/lib/company/service';
import { appendEvent } from '@/lib/company/manager/events';
import { classifyFailure, decideRetry, isAutomaticallyRetryable, type RetryDecision } from '@/lib/company/manager/failure';
import { redactSecret } from '@/lib/flows/errors';

const now = (): string => new Date().toISOString();

/**
 * Record the START of a real execution attempt — bump `attemptCount` durably and
 * stamp `startedAt`. Called from the dispatch paths at the `running` transition ONLY.
 * Direct write (attempt bookkeeping is not a user-editable field).
 */
export function beginTaskAttempt(db: FounderDb, taskId: string): CompanyTask {
  const t = db.companyTasks.get(taskId);
  if (!t) return t as never;
  const updated: CompanyTask = {
    ...t,
    attemptCount: (t.attemptCount ?? 0) + 1,
    startedAt: t.startedAt ?? now(),
    updatedAt: now(),
  };
  db.companyTasks.insert(updated);
  return updated;
}

/**
 * Persist last-failure metadata on a task that has just failed (status is set to
 * `failed` by the caller). Classifies the code, redacts the summary, and records a
 * bounded, secret-free explanation. Direct write; returns the classification.
 */
export function recordTaskFailure(
  db: FounderDb,
  taskId: string,
  input: { code?: string | null; summary?: string | null },
): { task: CompanyTask; decision: RetryDecision } | null {
  const t = db.companyTasks.get(taskId);
  if (!t) return null;
  const classification = classifyFailure(input.code);
  const updated: CompanyTask = {
    ...t,
    lastFailureCode: input.code ?? undefined,
    lastFailureClass: classification.class,
    lastFailureSummary: input.summary ? redactSecret(input.summary).slice(0, 300) : undefined,
    lastFailureAt: now(),
    updatedAt: now(),
  };
  db.companyTasks.insert(updated);
  const decision = decideRetry({ classification, attemptCount: updated.attemptCount ?? 0, maxAttempts: updated.maxAttempts ?? 3 });
  return { task: updated, decision };
}

/** The retry decision for a task, derived from its stored last-failure classification. */
export function retryDecisionForTask(db: FounderDb, taskId: string): RetryDecision | null {
  const t = db.companyTasks.get(taskId);
  if (!t) return null;
  const classification = classifyFailure(t.lastFailureCode);
  return decideRetry({ classification, attemptCount: t.attemptCount ?? 0, maxAttempts: t.maxAttempts ?? 3 });
}

/**
 * The controlled, dedicated `failed → queued` write (bypasses the ordinary transition guard).
 * Shared by the G1 auto/explicit retry paths and the G3 reassignment path — the ONLY sanctioned
 * way a failed task returns toward execution. Keeps the failure history; clears the prior run ref.
 */
export function moveFailedToQueued(db: FounderDb, task: CompanyTask): CompanyTask {
  const updated: CompanyTask = {
    ...task,
    status: 'queued',
    // A fresh attempt must not point at the previous run; keep the failure history.
    executionKind: undefined,
    executionRefId: undefined,
    updatedAt: now(),
  };
  db.companyTasks.insert(updated);
  return updated;
}

/**
 * Conservative G1 side-effect safety check for AUTOMATIC retry:
 * A transient failure alone does NOT make an unsafe, non-idempotent action automatically retryable.
 * If the system cannot prove the task execution is safe/idempotent to repeat, auto-retry is skipped.
 * Explicit human retry remains allowed when requested by an operator.
 */
export const SAFE_READ_ONLY_TOOL_SLUGS = new Set([
  'slack',
  'gmail',
  'notion',
  'stripe',
  'attio',
  'web.search',
]);

export function isTaskAutoRetrySafe(db: FounderDb, task: CompanyTask): boolean {
  if (task.lastFailureClass === 'APPROVAL_REQUIRED') return false;

  // Workflow task safety check
  if (task.workflowId || task.executionKind === 'workflow') {
    const wfId = task.workflowId;
    if (!wfId) return false;
    const wf = db.flowWorkflows.get(wfId);
    if (!wf || wf.currentVersion == null) return false;
    const ver = db.flowVersions.get(wfId, wf.currentVersion);
    if (!ver || !ver.graph || !Array.isArray(ver.graph.nodes)) return false;
    for (const node of ver.graph.nodes) {
      if (node.type === 'approval' || node.type === 'output') return false;
    }
    return true;
  }

  // Agent task safety check
  if (task.assignedAgentId || task.executionKind === 'agent') {
    const agentId = task.assignedAgentId;
    if (!agentId) return false;
    const customAgent = db.customAgents.get(agentId);
    const builtInAgent = db.agents.all().find((a) => a.id === agentId);
    if (!customAgent && !builtInAgent) return false;
    const tools = customAgent?.tools ?? builtInAgent?.tools ?? [];
    for (const toolSlug of tools) {
      if (!SAFE_READ_ONLY_TOOL_SLUGS.has(toolSlug)) {
        return false; // Unsafe / side-effect tool (e.g. telegram, gbrain save, or unclassified tool)
      }
    }
    return true;
  }

  return true;
}

/**
 * Manager auto-retry pass (bounded, no loop): for each `failed` task in the mission
 * whose classification is AUTOMATICALLY retryable and has attempts remaining, move it
 * back to `queued` (the dispatch loop re-runs it). A retryable-but-exhausted task emits
 * a one-time `TASK_RETRY_EXHAUSTED` and stays failed. Returns the promoted task ids.
 */
export function promoteRetryableFailures(db: FounderDb, missionId: string): string[] {
  const promoted: string[] = [];
  for (const t of db.companyTasks.forMission(missionId)) {
    if (t.status !== 'failed') continue;
    const classification = classifyFailure(t.lastFailureCode);
    const attemptCount = t.attemptCount ?? 0;
    const maxAttempts = t.maxAttempts ?? 3;
    const autoAllowed = isAutomaticallyRetryable({ classification, attemptCount, maxAttempts });
    const isSafe = isTaskAutoRetrySafe(db, t);

    if (autoAllowed && isSafe) {
      moveFailedToQueued(db, t);
      appendEvent(db, {
        type: 'TASK_RETRY_QUEUED',
        missionId,
        taskId: t.id,
        summary: `Auto-retry ${attemptCount + 1}/${maxAttempts} (${classification.class})`,
        metadata: { class: classification.class, attempt: attemptCount, maxAttempts, mode: 'automatic' },
      });
      promoted.push(t.id);
    } else if (classification.automaticRetryAllowed && attemptCount >= maxAttempts) {
      // Retryable class but budget spent — record once (guard on the event count).
      if (db.companyEvents.countForTask(t.id, 'TASK_RETRY_EXHAUSTED') === 0) {
        appendEvent(db, {
          type: 'TASK_RETRY_EXHAUSTED',
          missionId,
          taskId: t.id,
          summary: `Retry budget exhausted (${attemptCount}/${maxAttempts})`,
          metadata: { class: classification.class, attempt: attemptCount, maxAttempts },
        });
      }
    }
  }
  return promoted;
}

export type RetryTaskResult =
  | { ok: true; task: CompanyTask; decision: RetryDecision }
  | { ok: false; decision: RetryDecision };

/**
 * EXPLICIT human retry (API/CLI). Allowed only for a `failed` task whose decision is
 * RETRY_ALLOWED (retryable class + attempts remaining). Performs the controlled
 * `failed → queued` move + a `TASK_RETRY_QUEUED` event, then STOPS — it does not run
 * the task itself; the caller dispatches through the existing manager/dispatch path
 * (so approvals + tool preflight + no-silent-fallback all still apply). Non-retryable
 * failures are rejected with the decision (the reason the UI/CLI shows).
 */
export function retryTask(db: FounderDb, taskId: string): RetryTaskResult {
  const t = getCompanyTask(db, taskId);
  if (!t) throw new CompanyError('task not found', 404);
  const decision = retryDecisionForTask(db, taskId)!;
  if (t.status !== 'failed') {
    return { ok: false, decision: { ...decision, decision: 'NOT_RETRYABLE', reason: `task is ${t.status}, not failed` } };
  }
  if (!decision.explicitRetryAllowed || decision.decision !== 'RETRY_ALLOWED') return { ok: false, decision };
  const queued = moveFailedToQueued(db, t);
  appendEvent(db, {
    type: 'TASK_RETRY_QUEUED',
    missionId: t.missionId,
    taskId: t.id,
    summary: `Manual retry ${(t.attemptCount ?? 0) + 1}/${t.maxAttempts ?? 3} (${decision.class})`,
    metadata: { class: decision.class, attempt: t.attemptCount ?? 0, maxAttempts: t.maxAttempts ?? 3, mode: 'manual' },
  });
  return { ok: true, task: queued, decision };
}
