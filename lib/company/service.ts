/**
 * Company work service (Architecture V2 · F0.2) — the canonical create/read/update
 * boundary for Missions + Company Tasks. It COMPOSES the persistence repos, the
 * pure model (validation/transitions/graph rules), and the F0.1 capability
 * resolver (for eligibility + compat-checked manual assignment).
 *
 * It STORES and ORGANIZES work only. It performs NO planning, NO decomposition,
 * NO automatic assignment, NO delegation, and NO execution — setting `workflowId`
 * never starts a run; `waiting_approval` never creates a Phase-E approval (Human
 * Approval authority stays flow_approvals). All of that is F1.
 */
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { FounderDb } from '@/lib/db';
import { getAgentById, resolveAgentsForCapabilities } from '@/lib/agents/registry';
import type { AgentMatch } from '@/lib/agents/capabilities';
import { toolRequirementFor, satisfiesToolRequirement, toolGapReason } from '@/lib/agents/capability-tools';
import { WIRED_TOOL_SLUGS } from '@/lib/agents/agent-tools';
import {
  MissionInputSchema,
  MissionUpdateSchema,
  CompanyTaskInputSchema,
  CompanyTaskUpdateSchema,
  canTransitionMission,
  canTransitionTask,
  missionTaskSummary,
  prerequisitesSatisfied,
  wouldCreateCycle,
  DEFAULT_MAX_ATTEMPTS,
  type Mission,
  type MissionStatus,
  type CompanyTask,
  type CompanyTaskStatus,
  type MissionSummary,
  type Edge,
} from '@/lib/company/model';

/** A service-level error carrying the HTTP status the API should return. */
export class CompanyError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'CompanyError';
  }
}

/** Map a thrown service/validation error to an HTTP status + safe message (for API routes). */
export function companyErrorInfo(err: unknown): { status: number; error: string } {
  if (err instanceof CompanyError) return { status: err.status, error: err.message };
  if (err instanceof ZodError) return { status: 400, error: err.issues.map((i) => i.message).join('; ') || 'invalid input' };
  return { status: 500, error: 'internal error' };
}

const now = (): string => new Date().toISOString();
const TERMINAL_MISSION: MissionStatus[] = ['completed', 'failed', 'cancelled'];
const TERMINAL_TASK: CompanyTaskStatus[] = ['completed', 'failed', 'cancelled'];

// ── Missions ─────────────────────────────────────────────────────────────────

export function createMission(db: FounderDb, input: unknown): Mission {
  const parsed = MissionInputSchema.parse(input);
  const ts = now();
  const mission: Mission = {
    id: `mission-${randomUUID()}`,
    title: parsed.title,
    objective: parsed.objective,
    status: 'draft',
    priority: parsed.priority,
    createdBy: parsed.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  db.companyMissions.insert(mission);
  return mission;
}

export function getMission(db: FounderDb, id: string): Mission | null {
  return db.companyMissions.get(id);
}

export function listMissions(db: FounderDb): Mission[] {
  return db.companyMissions.all();
}

export function updateMission(db: FounderDb, id: string, patch: unknown): Mission {
  const existing = db.companyMissions.get(id);
  if (!existing) throw new CompanyError('mission not found', 404);
  const parsed = MissionUpdateSchema.parse(patch);

  let { status, startedAt, completedAt } = existing;
  if (parsed.status && parsed.status !== existing.status) {
    if (!canTransitionMission(existing.status, parsed.status)) {
      throw new CompanyError(`invalid mission transition: ${existing.status} → ${parsed.status}`);
    }
    status = parsed.status;
    if (status === 'active' && !startedAt) startedAt = now();
    if (TERMINAL_MISSION.includes(status)) completedAt = now();
  }
  const updated: Mission = {
    ...existing,
    title: parsed.title ?? existing.title,
    objective: parsed.objective ?? existing.objective,
    priority: parsed.priority ?? existing.priority,
    status,
    startedAt,
    completedAt,
    updatedAt: now(),
  };
  db.companyMissions.insert(updated);
  return updated;
}

/** Read-only derived task rollup — F0.2 never auto-completes a mission from it. */
export function missionSummary(db: FounderDb, missionId: string): MissionSummary {
  return missionTaskSummary(db.companyTasks.forMission(missionId));
}

// ── Company Tasks ────────────────────────────────────────────────────────────

export function createCompanyTask(db: FounderDb, missionId: string, input: unknown): CompanyTask {
  if (!db.companyMissions.get(missionId)) throw new CompanyError('mission not found', 404);
  const parsed = CompanyTaskInputSchema.parse(input);

  if (parsed.parentTaskId) {
    const parent = db.companyTasks.get(parsed.parentTaskId);
    if (!parent) throw new CompanyError('parent task not found', 404);
    if (parent.missionId !== missionId) throw new CompanyError('parent task belongs to a different mission');
  }
  if (parsed.workflowId && !db.flowWorkflows.get(parsed.workflowId)) {
    throw new CompanyError('unknown workflow', 400);
  }

  const ts = now();
  const task: CompanyTask = {
    id: `ctask-${randomUUID()}`,
    missionId,
    parentTaskId: parsed.parentTaskId,
    title: parsed.title,
    objective: parsed.objective,
    status: 'queued',
    priority: parsed.priority,
    requiredCapabilities: parsed.requiredCapabilities,
    workflowId: parsed.workflowId,
    attemptCount: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    createdAt: ts,
    updatedAt: ts,
  };
  db.companyTasks.insert(task);
  return task;
}

export function getCompanyTask(db: FounderDb, id: string): CompanyTask | null {
  return db.companyTasks.get(id);
}

export function listTasksForMission(db: FounderDb, missionId: string): CompanyTask[] {
  return db.companyTasks.forMission(missionId);
}

export function updateCompanyTask(db: FounderDb, id: string, patch: unknown): CompanyTask {
  const existing = db.companyTasks.get(id);
  if (!existing) throw new CompanyError('task not found', 404);
  const parsed = CompanyTaskUpdateSchema.parse(patch);

  let { status, startedAt, completedAt } = existing;
  if (parsed.status && parsed.status !== existing.status) {
    if (!canTransitionTask(existing.status, parsed.status)) {
      throw new CompanyError(`invalid task transition: ${existing.status} → ${parsed.status}`);
    }
    status = parsed.status;
    if (status === 'running' && !startedAt) startedAt = now();
    if (TERMINAL_TASK.includes(status)) completedAt = now();
  }

  // Reparent (optional): validate existence, same mission, no cycle in the parent tree.
  let parentTaskId = existing.parentTaskId;
  if (parsed.parentTaskId !== undefined) {
    if (parsed.parentTaskId === null) {
      parentTaskId = undefined;
    } else {
      const parent = db.companyTasks.get(parsed.parentTaskId);
      if (!parent) throw new CompanyError('parent task not found', 404);
      if (parent.missionId !== existing.missionId) throw new CompanyError('parent task belongs to a different mission');
      const parentEdges: Edge[] = db.companyTasks
        .forMission(existing.missionId)
        .filter((t) => t.parentTaskId)
        .map((t) => ({ from: t.id, to: t.parentTaskId! })); // child → parent
      if (wouldCreateCycle(parentEdges, id, parsed.parentTaskId)) throw new CompanyError('reparenting would create a cycle', 409);
      parentTaskId = parsed.parentTaskId;
    }
  }

  // Optional workflow / run seams — validated, never executed.
  let workflowId = existing.workflowId;
  if (parsed.workflowId !== undefined) {
    if (parsed.workflowId === null) workflowId = undefined;
    else {
      if (!db.flowWorkflows.get(parsed.workflowId)) throw new CompanyError('unknown workflow', 400);
      workflowId = parsed.workflowId;
    }
  }
  let runId = existing.runId;
  if (parsed.runId !== undefined) {
    if (parsed.runId === null) runId = undefined;
    else {
      const run = db.flowRuns.get(parsed.runId);
      if (!run) throw new CompanyError('unknown run', 400);
      if (workflowId && run.workflowId !== workflowId) throw new CompanyError('run does not belong to the task workflow', 400);
      runId = parsed.runId;
    }
  }

  const updated: CompanyTask = {
    ...existing,
    title: parsed.title ?? existing.title,
    objective: parsed.objective ?? existing.objective,
    priority: parsed.priority ?? existing.priority,
    requiredCapabilities: parsed.requiredCapabilities ?? existing.requiredCapabilities,
    parentTaskId,
    workflowId,
    runId,
    status,
    startedAt,
    completedAt,
    updatedAt: now(),
  };
  db.companyTasks.insert(updated);
  return updated;
}

/** Convenience wrapper: set a task's required capabilities (metadata; never auto-assigns). */
export function setTaskCapabilities(db: FounderDb, taskId: string, requiredCapabilities: string[]): CompanyTask {
  return updateCompanyTask(db, taskId, { requiredCapabilities });
}

/**
 * WHO COULD PERFORM THIS TASK — the F0.1 resolver over the task's required
 * capabilities (mode `all`). Read-only; never assigns. Empty when the task
 * declares no capabilities (nothing to match on).
 */
export function getEligibleAgentsForTask(db: FounderDb, taskId: string): AgentMatch[] {
  const task = db.companyTasks.get(taskId);
  if (!task) throw new CompanyError('task not found', 404);
  if (task.requiredCapabilities.length === 0) return [];
  return resolveAgentsForCapabilities(db, task.requiredCapabilities, { mode: 'all' });
}

/**
 * The EXPLICIT tool gaps for a task — a tool-backed required capability that NO agent can
 * currently satisfy because the required, wired tool is unavailable. This is why the
 * eligible list can be empty even though a capability label exists somewhere. Read-only,
 * SAFE (no connector config/secrets) — just the capability + a plain reason.
 */
export function getTaskToolGaps(db: FounderDb, taskId: string): { capabilityId: string; reason: string }[] {
  const task = db.companyTasks.get(taskId);
  if (!task) throw new CompanyError('task not found', 404);
  const available = new Set(WIRED_TOOL_SLUGS);
  const agents = db.customAgents.all();
  const gaps: { capabilityId: string; reason: string }[] = [];
  for (const cap of task.requiredCapabilities) {
    const req = toolRequirementFor(cap);
    if (!req) continue; // model-only capability — no tool gap possible
    const anyAgentSatisfies = agents.some((a) => satisfiesToolRequirement(req, a.tools ?? [], available));
    if (!anyAgentSatisfies) gaps.push({ capabilityId: cap, reason: toolGapReason(req) });
  }
  return gaps;
}

/**
 * Manually assign an agent to a task. HONEST: if the task declares required
 * capabilities, the agent must satisfy ALL of them — otherwise the assignment is
 * REJECTED (capability metadata must stay meaningful). Assigning does not run
 * anything; a `queued` task moves to `assigned`.
 */
export function assignTask(db: FounderDb, taskId: string, agentId: string): CompanyTask {
  const task = db.companyTasks.get(taskId);
  if (!task) throw new CompanyError('task not found', 404);
  if (!getAgentById(db, agentId)) throw new CompanyError('unknown agent', 404);

  if (task.requiredCapabilities.length > 0) {
    const eligible = resolveAgentsForCapabilities(db, task.requiredCapabilities, { mode: 'all' });
    if (!eligible.some((m) => m.agentId === agentId)) {
      throw new CompanyError(`agent ${agentId} lacks the required capabilities (${task.requiredCapabilities.join(', ')})`, 409);
    }
  }

  const status: CompanyTaskStatus = task.status === 'queued' ? 'assigned' : task.status;
  const updated: CompanyTask = { ...task, assignedAgentId: agentId, status, updatedAt: now() };
  db.companyTasks.insert(updated);
  return updated;
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export function addTaskDependency(db: FounderDb, taskId: string, dependsOnTaskId: string): void {
  if (taskId === dependsOnTaskId) throw new CompanyError('a task cannot depend on itself');
  const task = db.companyTasks.get(taskId);
  const dep = db.companyTasks.get(dependsOnTaskId);
  if (!task) throw new CompanyError('task not found', 404);
  if (!dep) throw new CompanyError('dependency task not found', 404);
  if (task.missionId !== dep.missionId) throw new CompanyError('cross-mission dependencies are not allowed');

  // Cycle guard over existing dependency edges (task → depends-on).
  const edges: Edge[] = db.companyTaskDeps.forMission(task.missionId).map((d) => ({ from: d.taskId, to: d.dependsOnTaskId }));
  if (wouldCreateCycle(edges, taskId, dependsOnTaskId)) throw new CompanyError('dependency would create a cycle', 409);

  db.companyTaskDeps.add(taskId, dependsOnTaskId); // idempotent (PK)
}

export function removeTaskDependency(db: FounderDb, taskId: string, dependsOnTaskId: string): void {
  db.companyTaskDeps.remove(taskId, dependsOnTaskId);
}

/** A task's prerequisites + whether they are all completed (read-only — never auto-starts). */
export function getTaskDependencies(db: FounderDb, taskId: string): { dependsOn: CompanyTask[]; satisfied: boolean } {
  const dependsOn = db.companyTaskDeps
    .forTask(taskId)
    .map((d) => db.companyTasks.get(d.dependsOnTaskId))
    .filter((t): t is CompanyTask => t !== null);
  return { dependsOn, satisfied: prerequisitesSatisfied(dependsOn.map((t) => t.status)) };
}
