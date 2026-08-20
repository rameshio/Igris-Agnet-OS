/**
 * G-Brain Neural — pure model (Architecture V2 · F5).
 *
 * Neural is a READ-ONLY projection of live/recent OPERATIONAL state: what is happening
 * through the company's connections right now. It is built from the F1 `company_events`
 * ledger (which supplies historical edges + timestamps) reconciled against CURRENT canonical
 * state (which supplies status) — it is NOT a runtime, NOT a second event store, and it never
 * mutates anything. Radial = structural · Neural = operational · Activity (U4) = chronological.
 *
 * This module is PURE (no DB/LLM): the closed node/edge/status enums, the window parser, the
 * bounds, the event→edge spec, and the canonical-status mappers are unit-testable without SQLite.
 */
import type { ApprovalStatus, RunStatus } from '@/lib/flows/run-types';
import type { CompanyEventType } from '@/lib/company/manager/model';
import type { CompanyTaskStatus, MissionStatus } from '@/lib/company/model';

// ── Closed enums ──────────────────────────────────────────────────────────────
export const NEURAL_NODE_KINDS = ['mission', 'task', 'agent', 'workflow', 'workflow_run', 'approval', 'artifact', 'event'] as const;
export type NeuralNodeKind = (typeof NEURAL_NODE_KINDS)[number];

export const NEURAL_STATUSES = ['idle', 'queued', 'running', 'waiting', 'waiting_approval', 'completed', 'failed', 'cancelled'] as const;
export type NeuralStatus = (typeof NEURAL_STATUSES)[number];

export const NEURAL_EDGE_TYPES = ['has_task', 'assigned_to', 'delegated_to', 'executed_by', 'ran_workflow', 'requested_approval', 'produced', 'handoff'] as const;
export type NeuralEdgeType = (typeof NEURAL_EDGE_TYPES)[number];

export type NeuralNode = {
  id: string; // canonical key, e.g. `mission:mission-1`
  kind: NeuralNodeKind;
  label: string;
  subtitle?: string;
  status?: NeuralStatus;
  canonicalRef?: { kind: string; id: string };
  occurredAt?: string;
  active: boolean;
};

export type NeuralEdge = {
  id: string; // `${from}|${type}|${to}`
  from: string;
  to: string;
  type: NeuralEdgeType;
  label?: string;
  occurredAt?: string;
};

export type NeuralGraph = {
  root?: string;
  nodes: NeuralNode[];
  edges: NeuralEdge[];
  generatedAt: string;
  window: { from: string; to: string };
  truncated: boolean;
};

// ── Time window (bounded) ─────────────────────────────────────────────────────
export const NEURAL_WINDOWS: Record<string, number> = { '15m': 15, '1h': 60, '6h': 360, '24h': 1440 };
export const NEURAL_DEFAULT_WINDOW = '1h';
export function parseWindow(w: string | null | undefined): { key: string; minutes: number } {
  const key = w && w in NEURAL_WINDOWS ? w : NEURAL_DEFAULT_WINDOW;
  return { key, minutes: NEURAL_WINDOWS[key] };
}

// ── Bounds (no "load all company history") ────────────────────────────────────
export const NEURAL_MAX_EVENTS = 250;
export const NEURAL_MAX_NODES = 150;
export const NEURAL_MAX_EDGES = 300;
export function clampNeuralLimit(n: number | undefined): number {
  if (!Number.isFinite(n)) return NEURAL_MAX_EVENTS;
  return Math.max(1, Math.min(Math.trunc(n as number), NEURAL_MAX_EVENTS));
}

export function nodeKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}
export function edgeId(from: string, to: string, type: NeuralEdgeType): string {
  return `${from}|${type}|${to}`;
}

// ── Event → operational edge spec (pure; only for event types that exist) ─────
export type EventEdgeSpec = { from: NeuralNodeKind; to: NeuralNodeKind; edge: NeuralEdgeType };
export type EventProjection = EventEdgeSpec | 'status' | 'event';

/**
 * How a ledger event projects into the graph:
 *   - an edge spec (relational: from→to with an edge type),
 *   - `'status'` (the event only marks a node's presence/status — no edge),
 *   - `'event'` (a lifecycle milestone rendered as an `event` node linked to its task/mission).
 */
export function projectionForEvent(type: CompanyEventType): EventProjection {
  switch (type) {
    case 'TASK_CREATED':
      return { from: 'mission', to: 'task', edge: 'has_task' };
    case 'TASK_ASSIGNED':
      return { from: 'task', to: 'agent', edge: 'assigned_to' };
    case 'TASK_DISPATCHED':
      return { from: 'task', to: 'agent', edge: 'delegated_to' };
    case 'AGENT_STARTED':
      return { from: 'task', to: 'agent', edge: 'executed_by' };
    case 'WORKFLOW_STARTED':
      return { from: 'task', to: 'workflow_run', edge: 'ran_workflow' };
    case 'APPROVAL_REQUIRED':
      return { from: 'task', to: 'approval', edge: 'requested_approval' };
    case 'ARTIFACT_CREATED':
      return { from: 'task', to: 'artifact', edge: 'produced' };
    case 'AGENT_PROMOTED':
      return { from: 'task', to: 'agent', edge: 'assigned_to' };
    case 'CAPABILITY_GAP':
    case 'AGENT_PROPOSED':
    case 'AGENT_REJECTED':
    case 'AGENT_RETIRED':
      return 'event';
    default:
      // MISSION_PLANNED / MISSION_COMPLETED / MISSION_FAILED / TASK_COMPLETED / TASK_FAILED
      return 'status';
  }
}

// ── Canonical-status mappers (current state is authority; never event replay) ─
export function mapTaskStatus(s: CompanyTaskStatus): NeuralStatus {
  switch (s) {
    case 'queued': return 'queued';
    case 'assigned': return 'queued';
    case 'running': return 'running';
    case 'waiting_dependency': return 'waiting';
    case 'waiting_approval': return 'waiting_approval';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'idle';
  }
}
export function mapMissionStatus(s: MissionStatus): NeuralStatus {
  switch (s) {
    case 'active': return 'running';
    case 'blocked': return 'waiting';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'idle'; // draft
  }
}
export function mapRunStatus(s: RunStatus): NeuralStatus {
  switch (s) {
    case 'queued': return 'queued';
    case 'running': return 'running';
    case 'waiting_approval': return 'waiting_approval';
    case 'success': return 'completed';
    case 'failed': return 'failed';
    case 'canceled': return 'cancelled';
    case 'interrupted': return 'failed';
    default: return 'idle';
  }
}
export function mapApprovalStatus(s: ApprovalStatus): NeuralStatus {
  switch (s) {
    case 'pending': return 'waiting_approval';
    case 'approved': return 'completed';
    case 'rejected': return 'failed';
    case 'expired': return 'cancelled';
    case 'cancelled': return 'cancelled';
    default: return 'idle';
  }
}
export function isActiveStatus(s: NeuralStatus | undefined): boolean {
  return s === 'running' || s === 'queued' || s === 'waiting' || s === 'waiting_approval';
}
