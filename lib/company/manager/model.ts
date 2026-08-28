/**
 * Executive Manager — pure model (Architecture V2 · F1).
 *
 * The company-work layer gains a MANAGER that plans a Mission, decomposes it into
 * Company Tasks, matches capabilities (F0.1), delegates to an existing agent OR an
 * existing published workflow, records structured Artifacts, appends an event
 * ledger, and synthesizes a report. This module is PURE (zod + F0.1/F0.2 model
 * only) so the plan schema, the CLOSED manager-action allow-list, the Artifact +
 * Event shapes (with SAFE projections), and the DETERMINISTIC dispatch/selection
 * policy are unit-testable without SQLite/LLM.
 *
 * Bounded & human-controlled: NO autonomous loop, NO Agent Factory, NO new
 * approval authority, NO parallel workflow engine, NO G-Brain ingestion.
 */
import { z } from 'zod';
import { isValidCapabilityId, normalizeCapabilityId } from '@/lib/agents/capabilities';
import type { MissionStatus, CompanyTaskStatus } from '@/lib/company/model';

export type ExecutionKind = 'agent' | 'workflow';

// ── Closed manager-action allow-list (U3-style safety: only these typed ops) ──
export const MANAGER_ACTIONS = [
  'plan_mission',
  'create_task',
  'update_task',
  'assign_task',
  'dispatch_agent',
  'dispatch_workflow',
  'record_artifact',
  'complete_task',
  'fail_task',
  'request_approval',
  'summarize_mission',
  'manager_step',
] as const;
export type ManagerAction = (typeof MANAGER_ACTIONS)[number];

// ── Company Artifact (first-class work product) ──────────────────────────────
export type CompanyArtifact = {
  id: string;
  missionId: string;
  taskId?: string;
  producedByAgentId?: string;
  workflowRunId?: string;
  type: string;
  title: string;
  summary?: string;
  content?: unknown; // full work product — NEVER exposed by broad summary feeds
  contentType?: string;
  sourceRefs?: string[];
  createdAt: string;
};

export const CompanyArtifactInputSchema = z.object({
  missionId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  producedByAgentId: z.string().min(1).optional(),
  workflowRunId: z.string().min(1).optional(),
  type: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(200),
  summary: z.string().max(2000).optional(),
  content: z.unknown().optional(),
  contentType: z.string().max(60).optional(),
  sourceRefs: z.array(z.string().max(200)).max(50).optional(),
});
export type CompanyArtifactInput = z.infer<typeof CompanyArtifactInputSchema>;

/** SAFE projection — identifiers + labels only, NEVER the artifact content. */
export type SafeArtifactSummary = {
  id: string;
  missionId: string;
  taskId?: string;
  producedByAgentId?: string;
  workflowRunId?: string;
  type: string;
  title: string;
  summary?: string;
  createdAt: string;
};

export function safeArtifactSummary(a: CompanyArtifact): SafeArtifactSummary {
  return {
    id: a.id,
    missionId: a.missionId,
    taskId: a.taskId,
    producedByAgentId: a.producedByAgentId,
    workflowRunId: a.workflowRunId,
    type: a.type,
    title: a.title,
    summary: a.summary,
    createdAt: a.createdAt,
  };
}

// ── Company Event ledger (append-only; NOT canonical state) ───────────────────
export const COMPANY_EVENT_TYPES = [
  'MISSION_PLANNED',
  'TASK_CREATED',
  'TASK_ASSIGNED',
  'TASK_DISPATCHED',
  'AGENT_STARTED',
  'WORKFLOW_STARTED',
  'ARTIFACT_CREATED',
  'APPROVAL_REQUIRED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'CAPABILITY_GAP',
  // Reliability G1 — bounded task retry (controlled failed→queued; no auto loop).
  'TASK_RETRY_QUEUED',
  'TASK_RETRY_EXHAUSTED',
  // Agent Factory (F2) — human-gated dynamic agent creation that fills a gap.
  'AGENT_PROPOSED',
  'AGENT_PROMOTED',
  'AGENT_REJECTED',
  'AGENT_RETIRED',
  'MISSION_COMPLETED',
  'MISSION_FAILED',
] as const;
export type CompanyEventType = (typeof COMPANY_EVENT_TYPES)[number];

/** Bounded, safe metadata: small scalar map only (never prompts/secrets/tool args). */
export const EventMetadataSchema = z
  .record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
  .refine((m) => Object.keys(m).length <= 12, 'event metadata is bounded to 12 keys');
export type EventMetadata = z.infer<typeof EventMetadataSchema>;

export type CompanyEvent = {
  id: string;
  type: CompanyEventType;
  missionId?: string;
  taskId?: string;
  agentId?: string;
  workflowId?: string;
  artifactId?: string;
  summary: string;
  metadata?: EventMetadata;
  createdAt: string;
};

export const CompanyEventInputSchema = z.object({
  type: z.enum(COMPANY_EVENT_TYPES),
  missionId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  artifactId: z.string().min(1).optional(),
  summary: z.string().max(300),
  metadata: EventMetadataSchema.optional(),
});
export type CompanyEventInput = z.infer<typeof CompanyEventInputSchema>;

// ── Mission plan (LLM-produced, schema-constrained; ids assigned by the server) ─
const CapabilityRefSchema = z
  .string()
  .transform(normalizeCapabilityId)
  .refine(isValidCapabilityId, 'invalid capability id — use lowercase `domain.action`');

export const PlannedTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().max(2000).optional(),
  requiredCapabilities: z.array(CapabilityRefSchema).max(20).default([]),
  /** References OTHER planned tasks BY TITLE (ids don't exist yet); resolved on apply. */
  dependsOn: z.array(z.string().min(1).max(200)).max(20).optional(),
  executionPreference: z.enum(['agent', 'workflow', 'either']).optional(),
});
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;

export const MissionPlanSchema = z.object({
  rationale: z.string().max(2000).optional(),
  tasks: z.array(PlannedTaskSchema).min(1).max(20),
});
export type MissionPlan = z.infer<typeof MissionPlanSchema>;

// ── Reports ──────────────────────────────────────────────────────────────────
export type MissionTaskCounts = {
  total: number;
  queued: number;
  assigned: number;
  running: number;
  waiting: number; // waiting_dependency + waiting_approval
  completed: number;
  failed: number;
  cancelled: number;
};

export type Blocker = {
  taskId: string;
  title: string;
  reason: 'capability_gap' | 'failed' | 'waiting_approval' | 'waiting_dependency';
  requiredCapabilities?: string[];
  missingCapabilities?: string[];
};

export type CapabilityGap = {
  taskId: string;
  title: string;
  requiredCapabilities: string[];
  missingCapabilities: string[];
  reason: 'capability_gap';
};

export type MissionReport = {
  missionId: string;
  status: MissionStatus;
  taskCounts: MissionTaskCounts;
  artifacts: SafeArtifactSummary[];
  blockers: Blocker[];
  capabilityGaps: CapabilityGap[];
  managerSummary?: string;
};

// ── Deterministic dispatch policy (pure) ─────────────────────────────────────

export type DispatchTarget =
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'gap'; reason: 'capability_gap' | 'no_target'; missingCapabilities: string[] };

/**
 * Conservative, documented policy (item 12):
 *   valid published workflow → workflow
 *   else an assigned/selected eligible agent → agent
 *   else required capabilities with no match → capability_gap
 *   else nothing to run → no_target
 */
export function chooseDispatchTarget(input: {
  workflowId?: string;
  hasPublishedWorkflow: boolean;
  chosenAgentId?: string;
  requiredCapabilities: string[];
  missingCapabilities: string[];
}): DispatchTarget {
  if (input.workflowId && input.hasPublishedWorkflow) return { kind: 'workflow', workflowId: input.workflowId };
  if (input.chosenAgentId) return { kind: 'agent', agentId: input.chosenAgentId };
  if (input.requiredCapabilities.length > 0) {
    return { kind: 'gap', reason: 'capability_gap', missingCapabilities: input.missingCapabilities.length ? input.missingCapabilities : input.requiredCapabilities };
  }
  return { kind: 'gap', reason: 'no_target', missingCapabilities: [] };
}

/**
 * Pick an agent from the capability-ranked eligible list. Capability rank is
 * PRIMARY (the list is already ranked by the F0.1 resolver); real U5 presence only
 * refines it — the first eligible agent NOT currently busy (working /
 * waiting_approval) wins, else the top-ranked eligible agent. Deterministic; never
 * fabricates availability.
 */
export function selectAgent(rankedEligibleAgentIds: string[], busyAgentIds: ReadonlySet<string>): string | null {
  for (const id of rankedEligibleAgentIds) if (!busyAgentIds.has(id)) return id;
  return rankedEligibleAgentIds[0] ?? null;
}

// ── Mission completion policy (deterministic) ────────────────────────────────

/**
 * A mission is complete ONLY when every non-cancelled task is `completed` and none
 * failed (partial success never auto-completes). A failed task blocks completion.
 */
export function deriveMissionComplete(taskStatuses: CompanyTaskStatus[]): boolean {
  const relevant = taskStatuses.filter((s) => s !== 'cancelled');
  if (relevant.length === 0) return false;
  if (relevant.some((s) => s === 'failed')) return false;
  return relevant.every((s) => s === 'completed');
}
