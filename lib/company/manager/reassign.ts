/**
 * Controlled agent reassignment (Reliability Phase G3).
 *
 * When a Company Task fails because the ASSIGNED AGENT is specifically the problem —
 * not the task, provider, tool, permission, input, or a shared/transient condition —
 * and another already-eligible agent can safely execute the SAME task, the Manager
 * reassigns it (Agent A → Agent B) and lets the normal retry/dispatch flow run it.
 *
 * This is NOT provider fallback, NOT tool fallback, NOT Agent-Factory creation, and NOT
 * an arbitrary load balancer. It reuses the ONE canonical eligibility resolver
 * (`resolveAgentsForCapabilities`: capability + required WIRED tool) and the canonical
 * deterministic picker (`selectAgent`) — if normal dispatch would reject a candidate, so
 * does reassignment. No new eligibility engine.
 *
 * Agent-specific failure (conservative, PROVABLE): the currently-assigned agent is no
 * longer in the task's eligible set (removed / retired / lost a required wired tool), while
 * at least one OTHER agent still is. A still-eligible agent that merely hit a shared or
 * transient failure is NOT agent-specific — that stays a same-agent G1 retry (no rotation).
 *
 * Attempt semantics: reassignment marks the already-counted attempt and moves the task
 * `failed → queued` (the shared controlled transition) WITHOUT touching `attemptCount`; the
 * next real dispatch increments it (the G1 rule). Side-effect + approval safety are the
 * SAME G1/G2 rules — an unsafe or human-action failure is never auto-reassigned.
 */
import type { FounderDb } from '@/lib/db';
import type { CompanyTask, CompanyTaskStatus } from '@/lib/company/model';
import { getCompanyTask, assignTask } from '@/lib/company/service';
import { resolveAgentsForCapabilities } from '@/lib/agents/registry';
import { selectAgent } from '@/lib/company/manager/model';
import { buildAgentPresence } from '@/lib/agents/presence-service';
import { classifyFailure } from '@/lib/company/manager/failure';
import { isTaskAutoRetrySafe, moveFailedToQueued } from '@/lib/company/manager/retry';
import { appendEvent } from '@/lib/company/manager/events';

export type ReassignmentDecisionKind =
  | 'REASSIGN_ALLOWED'
  | 'NO_ALTERNATE_AGENT'
  | 'FAILURE_NOT_AGENT_SPECIFIC'
  | 'RETRY_EXHAUSTED'
  | 'UNSAFE_TO_REPEAT'
  | 'HUMAN_ACTION_REQUIRED'
  | 'NOT_APPLICABLE';

export type ReassignmentDecision = {
  decision: ReassignmentDecisionKind;
  fromAgentId?: string;
  toAgentId?: string; // the chosen alternate — only on REASSIGN_ALLOWED
  candidateCount: number; // eligible alternates (EXCLUDING the failed agent)
  attemptCount: number;
  maxAttempts: number;
  reason: string;
};

/**
 * PURE reassignment decision — no DB access, no mutation. Deterministic and testable.
 * All eligibility/safety facts are resolved by the caller from the canonical services and
 * passed in; this function only classifies them into a decision.
 */
export function decideReassignment(input: {
  status: CompanyTaskStatus;
  assignedAgentId?: string;
  attemptCount: number;
  maxAttempts: number;
  /** Is the currently-assigned agent STILL eligible per the canonical resolver? */
  assignedStillEligible: boolean;
  /** Is repeating the task safe (G1/G2 side-effect rule)? */
  safeToRepeat: boolean;
  /** Does the last failure require a human (approval/permission/config/invalid/gap)? */
  requiresHumanAction: boolean;
  /** Ranked eligible alternates EXCLUDING the failed agent (capability + wired tool checked). */
  alternateEligibleIds: string[];
  /** Deterministic pick from the alternates (canonical `selectAgent`), or undefined. */
  chosenAgentId?: string;
}): ReassignmentDecision {
  const base = {
    fromAgentId: input.assignedAgentId,
    candidateCount: input.alternateEligibleIds.length,
    attemptCount: input.attemptCount,
    maxAttempts: input.maxAttempts,
  };

  if (input.status !== 'failed' || !input.assignedAgentId)
    return { ...base, decision: 'NOT_APPLICABLE', reason: 'task is not a failed, agent-assigned task' };
  // Approval / permission / config / invalid-input / review-required — a human must act;
  // reassignment must NEVER be used to route around one of these.
  if (input.requiresHumanAction)
    return { ...base, decision: 'HUMAN_ACTION_REQUIRED', reason: 'failure needs a human — never reassigned around' };
  // Uncertain/possible external side effect — never auto-reassign (repetition is not safer).
  if (!input.safeToRepeat)
    return { ...base, decision: 'UNSAFE_TO_REPEAT', reason: 'repeating may duplicate an external side effect — review required' };
  if (input.attemptCount >= input.maxAttempts)
    return { ...base, decision: 'RETRY_EXHAUSTED', reason: `retry budget exhausted (${input.attemptCount}/${input.maxAttempts})` };
  // The agent is fine — a shared/transient failure stays a SAME-agent G1 retry (no rotation).
  if (input.assignedStillEligible)
    return { ...base, decision: 'FAILURE_NOT_AGENT_SPECIFIC', reason: 'assigned agent is still eligible — retry the same agent' };
  // Agent-specific, but nobody else can do it → no reassignment (no Factory auto-create, no relaxing checks).
  if (input.alternateEligibleIds.length === 0 || !input.chosenAgentId)
    return { ...base, decision: 'NO_ALTERNATE_AGENT', reason: 'no other eligible agent available' };
  // Defensive: never pick the failed agent for this decision.
  if (input.chosenAgentId === input.assignedAgentId)
    return { ...base, decision: 'NO_ALTERNATE_AGENT', reason: 'only the failed agent is eligible' };

  return { ...base, decision: 'REASSIGN_ALLOWED', toAgentId: input.chosenAgentId, reason: 'assigned agent no longer eligible; another eligible agent selected' };
}

/** Resolve all the canonical facts for a task and produce the reassignment decision — READ-ONLY (no mutation). */
export function evaluateReassignment(db: FounderDb, taskId: string): ReassignmentDecision {
  const task = getCompanyTask(db, taskId);
  if (!task) return { decision: 'NOT_APPLICABLE', candidateCount: 0, attemptCount: 0, maxAttempts: 0, reason: 'task not found' };

  // ONE canonical eligibility resolver (capability + required wired tool) — never a second engine.
  const eligibleIds = task.requiredCapabilities.length
    ? resolveAgentsForCapabilities(db, task.requiredCapabilities, { mode: 'all' }).map((m) => m.agentId)
    : [];
  const assignedStillEligible = !!task.assignedAgentId && eligibleIds.includes(task.assignedAgentId);
  const alternateEligibleIds = eligibleIds.filter((id) => id !== task.assignedAgentId); // failed agent EXCLUDED
  const busy = new Set(
    buildAgentPresence(db)
      .filter((p) => p.state === 'working' || p.state === 'waiting_approval')
      .map((p) => p.agentId),
  );
  const chosenAgentId = selectAgent(alternateEligibleIds, busy) ?? undefined; // canonical deterministic pick

  return decideReassignment({
    status: task.status,
    assignedAgentId: task.assignedAgentId,
    attemptCount: task.attemptCount ?? 0,
    maxAttempts: task.maxAttempts ?? 3,
    assignedStillEligible,
    safeToRepeat: isTaskAutoRetrySafe(db, task),
    requiresHumanAction: classifyFailure(task.lastFailureCode).humanActionRequired,
    alternateEligibleIds,
    chosenAgentId,
  });
}

/**
 * Reassign a failed, agent-specific task to another eligible agent IF warranted. Reuses the
 * canonical eligibility + picker via `evaluateReassignment`; on REASSIGN_ALLOWED it reassigns
 * (capability-compat-checked `assignTask`), emits ONE `TASK_REASSIGNED`, and moves the task
 * `failed → queued` (shared controlled transition — attemptCount untouched). It NEVER dispatches
 * (the manager dispatch loop does, incrementing the attempt on the new agent), never creates an
 * agent (no Factory), never relaxes capability/tool checks, and never picks the failed agent.
 */
export function reassignTaskIfWarranted(db: FounderDb, taskId: string): ReassignmentDecision {
  const decision = evaluateReassignment(db, taskId);
  if (decision.decision !== 'REASSIGN_ALLOWED' || !decision.toAgentId) return decision;

  const task = getCompanyTask(db, taskId)!;
  const fromAgentId = task.assignedAgentId;
  assignTask(db, taskId, decision.toAgentId); // compat-checked; failed status preserved, assignee → B
  const reassigned = getCompanyTask(db, taskId)!;
  appendEvent(db, {
    type: 'TASK_REASSIGNED',
    missionId: task.missionId,
    taskId,
    agentId: decision.toAgentId,
    summary: `Reassigned ${fromAgentId ?? '?'} → ${decision.toAgentId} (attempt ${decision.attemptCount}/${decision.maxAttempts})`,
    metadata: {
      fromAgentId: fromAgentId ?? null,
      toAgentId: decision.toAgentId,
      attempt: decision.attemptCount,
      class: task.lastFailureClass ?? null,
      code: task.lastFailureCode ?? null,
      candidateCount: decision.candidateCount,
      reason: 'assigned_agent_ineligible',
    },
  });
  moveFailedToQueued(db, reassigned); // failed → queued (keeps failure history + the new assignee)
  return decision;
}

export type ReassignmentOutcome = { taskId: string; decision: ReassignmentDecisionKind; toAgentId?: string };

/** Manager pass (bounded, no loop): attempt reassignment for every failed task in a mission. */
export function reassignAgentSpecificFailures(db: FounderDb, missionId: string): ReassignmentOutcome[] {
  const outcomes: ReassignmentOutcome[] = [];
  for (const t of db.companyTasks.forMission(missionId)) {
    if (t.status !== 'failed') continue;
    const d = reassignTaskIfWarranted(db, t.id);
    if (d.decision === 'REASSIGN_ALLOWED') outcomes.push({ taskId: t.id, decision: d.decision, toAgentId: d.toAgentId });
  }
  return outcomes;
}
