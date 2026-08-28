/**
 * Company work model — Mission + Company Task (Architecture V2 · F0.2).
 *
 * The canonical company-work layer, DISTINCT from the existing lightweight
 * `agent_tasks` kanban (that stays untouched — see docs/ARCHITECTURE.md):
 *   MISSION      = a company-level objective
 *   COMPANY TASK = a unit of work required to complete a Mission
 *   AGENT        = employee (F0.1 registry)      WORKFLOW = SOP      RUN = execution
 *
 * F0.2 is DATA MODEL + canonical services + minimal UI/API only. It STORES and
 * ORGANIZES work — it does NOT plan, decompose, assign automatically, delegate,
 * or execute anything (that is F1). This module is PURE (only zod + the F0.1 id
 * rules) so statuses, transitions, parent/dependency validation, and the mission
 * summary are fully unit-testable without SQLite.
 */
import { z } from 'zod';
import { isValidCapabilityId, normalizeCapabilityId } from '@/lib/agents/capabilities';

// ── Enums ────────────────────────────────────────────────────────────────────
// `archived` (G-Brain consolidation) — a terminal, hidden-from-default-view state.
// A mission can be archived from ANY state (lifecycle-safe cleanup; provenance kept).
export const MISSION_STATUSES = ['draft', 'active', 'blocked', 'completed', 'failed', 'cancelled', 'archived'] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const COMPANY_TASK_STATUSES = [
  'queued',
  'assigned',
  'running',
  'waiting_dependency',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const;
export type CompanyTaskStatus = (typeof COMPANY_TASK_STATUSES)[number];

export const WORK_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export type WorkPriority = (typeof WORK_PRIORITIES)[number];

// ── Row types ────────────────────────────────────────────────────────────────
export type Mission = {
  id: string;
  title: string;
  objective?: string;
  status: MissionStatus;
  priority: WorkPriority;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type CompanyTask = {
  id: string;
  missionId: string;
  parentTaskId?: string;
  title: string;
  objective?: string;
  status: CompanyTaskStatus;
  assignedAgentId?: string;
  workflowId?: string; // an SOP this task is INTENDED to run via — F0.2 never runs it
  runId?: string; // F0.2 workflow-run seam (kept); F1 dispatch also records it for workflow runs
  // F1 canonical current-execution pointer — NEVER overloads runId (a flow-run id)
  // with an agent-run id. `agent` → an agent_runs id; `workflow` → a flow_runs id.
  executionKind?: 'agent' | 'workflow';
  executionRefId?: string;
  priority: WorkPriority;
  requiredCapabilities: string[]; // F0.1 capability ids — metadata, never auto-assigns
  // Reliability G1 — bounded attempt tracking. `attemptCount` = execution attempts
  // already STARTED (0 for a fresh task; incremented exactly once per real dispatch,
  // never by eligibility/preview/planning/approval-wait/capability-gap). Retry is a
  // controlled failed→queued transition through the dedicated retry service only.
  attemptCount: number;
  maxAttempts: number;
  lastFailureCode?: string;
  lastFailureClass?: string;
  lastFailureSummary?: string;
  lastFailureAt?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

/** Default retry budget for a new company task (Reliability G1). */
export const DEFAULT_MAX_ATTEMPTS = 3;

export type CompanyTaskDependency = { taskId: string; dependsOnTaskId: string; createdAt: string };

// ── Input validation (Zod) ───────────────────────────────────────────────────
const CapabilityRefSchema = z
  .string()
  .transform(normalizeCapabilityId)
  .refine(isValidCapabilityId, 'invalid capability id — use lowercase `domain.action`');

export const MissionInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().max(4000).optional(),
  priority: z.enum(WORK_PRIORITIES).default('normal'),
  createdBy: z.string().max(120).optional(),
});
export type MissionInput = z.infer<typeof MissionInputSchema>;

export const MissionUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    objective: z.string().max(4000),
    priority: z.enum(WORK_PRIORITIES),
    status: z.enum(MISSION_STATUSES),
  })
  .partial();
export type MissionUpdate = z.infer<typeof MissionUpdateSchema>;

export const CompanyTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().max(4000).optional(),
  parentTaskId: z.string().min(1).optional(),
  priority: z.enum(WORK_PRIORITIES).default('normal'),
  requiredCapabilities: z.array(CapabilityRefSchema).max(20).default([]),
  workflowId: z.string().min(1).optional(),
});
export type CompanyTaskInput = z.infer<typeof CompanyTaskInputSchema>;

export const CompanyTaskUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    objective: z.string().max(4000),
    priority: z.enum(WORK_PRIORITIES),
    status: z.enum(COMPANY_TASK_STATUSES),
    parentTaskId: z.string().min(1).nullable(),
    requiredCapabilities: z.array(CapabilityRefSchema).max(20),
    workflowId: z.string().min(1).nullable(),
    runId: z.string().min(1).nullable(),
  })
  .partial();
export type CompanyTaskUpdate = z.infer<typeof CompanyTaskUpdateSchema>;

// ── Status transitions (one central validator) ───────────────────────────────
//
// F0.2 does NOT drive states automatically; these guard manual/service updates so
// a status can never jump arbitrarily. Same-status is always a no-op.

// `archived` is a terminal state reached via the cleanup seam's DIRECT write
// (archiveMission), never through this normal transition graph — so completed/
// failed/cancelled remain terminal here and `isMissionTerminal` stays honest.
export const MISSION_TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  draft: ['active', 'cancelled'],
  active: ['blocked', 'completed', 'failed', 'cancelled'],
  blocked: ['active', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  archived: [],
};

export const TASK_TRANSITIONS: Record<CompanyTaskStatus, CompanyTaskStatus[]> = {
  queued: ['assigned', 'waiting_dependency', 'cancelled'],
  assigned: ['running', 'queued', 'waiting_dependency', 'waiting_approval', 'cancelled'],
  running: ['completed', 'failed', 'waiting_approval', 'waiting_dependency', 'cancelled'],
  waiting_dependency: ['queued', 'assigned', 'running', 'cancelled'],
  waiting_approval: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionMission(from: MissionStatus, to: MissionStatus): boolean {
  return to === from || MISSION_TRANSITIONS[from].includes(to);
}
export function canTransitionTask(from: CompanyTaskStatus, to: CompanyTaskStatus): boolean {
  return to === from || TASK_TRANSITIONS[from].includes(to);
}

/** Terminal states (no further transitions). */
export function isMissionTerminal(s: MissionStatus): boolean {
  return MISSION_TRANSITIONS[s].length === 0;
}
export function isTaskTerminal(s: CompanyTaskStatus): boolean {
  return TASK_TRANSITIONS[s].length === 0;
}

// ── Graph helpers (pure) — reused for parent-tree + dependency-DAG cycles ─────

export type Edge = { from: string; to: string };

/** Can `from` reach `to` by following edges (from→to)? DFS, cycle-safe. */
export function reaches(edges: Edge[], from: string, to: string): boolean {
  if (from === to) return true;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === to) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adj.get(node) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Would adding edge `newFrom → newTo` create a cycle, given existing edges?
 * True when `newTo` can already reach `newFrom` (or it is a self-edge).
 */
export function wouldCreateCycle(edges: Edge[], newFrom: string, newTo: string): boolean {
  if (newFrom === newTo) return true;
  return reaches(edges, newTo, newFrom);
}

// ── Mission summary (read-only derived; F0.2 does NOT auto-complete missions) ──

export type MissionSummary = {
  total: number;
  byStatus: Record<CompanyTaskStatus, number>;
};

export function missionTaskSummary(tasks: Pick<CompanyTask, 'status'>[]): MissionSummary {
  const byStatus = Object.fromEntries(COMPANY_TASK_STATUSES.map((s) => [s, 0])) as Record<CompanyTaskStatus, number>;
  for (const t of tasks) byStatus[t.status] += 1;
  return { total: tasks.length, byStatus };
}

/** True when every prerequisite of a task is `completed`. Read-only — never auto-starts. */
export function prerequisitesSatisfied(prerequisiteStatuses: CompanyTaskStatus[]): boolean {
  return prerequisiteStatuses.every((s) => s === 'completed');
}
