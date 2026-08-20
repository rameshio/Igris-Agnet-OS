/**
 * Company Intelligence — pure model (Architecture V2 · F6).
 *
 * F6 is a DERIVED, READ-ONLY analytical layer over the systems already built
 * (missions, company tasks, agents, capabilities, workflow runs, approvals,
 * events, proposals). It answers "what is slowing the company down / where are
 * gaps / which work waits too long?" — decision support, NOT a second source of
 * truth and NOT another orchestration system. It never mutates canonical state,
 * never creates agents, never automates remediation.
 *
 * This module is PURE (only `zod`): the window/threshold constants, the closed
 * snapshot + signal shapes, the coverage classifier, the duration statistics, and
 * the DETERMINISTIC signal derivation are all unit-testable without SQLite.
 *
 * NO FAKE PRECISION: any metric the underlying data cannot defensibly support is
 * `null` (read: insufficient_data) — never a manufactured number. Cost, tokens,
 * utilization %, and quality scores are deliberately absent (no telemetry backs
 * them). We never rank a "best" agent.
 */
import { z } from 'zod';
import type { CompanyTaskStatus, MissionStatus } from '@/lib/company/model';

// ── Error (carries the HTTP status the API should return) ─────────────────────
export class IntelError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = 'IntelError';
  }
}
export function intelErrorInfo(err: unknown): { status: number; error: string } {
  if (err instanceof IntelError) return { status: err.status, error: err.message };
  if (err instanceof z.ZodError) return { status: 400, error: err.issues.map((i) => i.message).join('; ') || 'invalid input' };
  return { status: 500, error: 'internal error' };
}

// ── Time windows (bounded; some metrics are windowed, some are current-state) ──
export const INTEL_WINDOWS = { '1h': 60, '24h': 1440, '7d': 10080, '30d': 43200 } as const;
export type IntelWindowKey = keyof typeof INTEL_WINDOWS;
/** Conservative default for analysis (item 6). */
export const DEFAULT_INTEL_WINDOW: IntelWindowKey = '7d';

export type WindowBounds = { key: IntelWindowKey; fromMs: number; toMs: number; fromIso: string; toIso: string };

/**
 * Resolve a window key. An ABSENT value falls back to the default; a PRESENT but
 * unknown value is REJECTED (item 22 — validate window, no generic query). Strict
 * so a URL parameter can never widen the analysis window arbitrarily.
 */
export function parseIntelWindow(raw?: string | null): IntelWindowKey {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_INTEL_WINDOW;
  if (raw in INTEL_WINDOWS) return raw as IntelWindowKey;
  throw new IntelError(`invalid window — use one of ${Object.keys(INTEL_WINDOWS).join(', ')}`);
}

/** Build the concrete [from, to] bounds for a window relative to `nowMs`. */
export function resolveWindow(key: IntelWindowKey, nowMs: number = Date.now()): WindowBounds {
  const fromMs = nowMs - INTEL_WINDOWS[key] * 60_000;
  return { key, fromMs, toMs: nowMs, fromIso: new Date(fromMs).toISOString(), toIso: new Date(nowMs).toISOString() };
}

/** True when an ISO timestamp falls inside the window (inclusive). Bad/absent → false. */
export function inWindow(iso: string | undefined | null, w: WindowBounds): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t >= w.fromMs && t <= w.toMs;
}

// ── Thresholds (centralized — never scatter magic numbers; item 11) ───────────
export const INTEL_THRESHOLDS = {
  staleQueuedMs: 24 * 60 * 60 * 1000, // a queued task idle this long is stale
  staleWaitingDependencyMs: 24 * 60 * 60 * 1000,
  staleWaitingApprovalMs: 24 * 60 * 60 * 1000,
  longRunningTaskMs: 2 * 60 * 60 * 1000, // a task running longer than this is flagged
  longApprovalWaitMs: 30 * 60 * 1000, // a pending approval older than this is an approval_delay
  repeatedFailureCount: 3, // TASK_FAILED events for one task within the window
  agentActiveTaskWarning: 3, // concurrent active assignments that warns of overload
  workflowFailureClusterMinRuns: 3, // minimum sample before a failure cluster can signal
  workflowFailureClusterRate: 0.5, // ≥ this share of windowed runs failed
} as const;

/** The stale threshold that applies to a given non-terminal task status, or null (never stale). */
export function staleThresholdForStatus(status: CompanyTaskStatus): number | null {
  switch (status) {
    case 'queued':
    case 'assigned':
      return INTEL_THRESHOLDS.staleQueuedMs;
    case 'waiting_dependency':
      return INTEL_THRESHOLDS.staleWaitingDependencyMs;
    case 'waiting_approval':
      return INTEL_THRESHOLDS.staleWaitingApprovalMs;
    default:
      return null; // running is handled as long-running; terminal states are never stale
  }
}

// ── Coverage classification (capability intelligence) ─────────────────────────
export const COVERAGE_STATUSES = ['healthy', 'single_point', 'gap'] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** 0 eligible → gap · exactly 1 → single point of failure · ≥2 → healthy. */
export function classifyCoverage(eligibleAgents: number): CoverageStatus {
  if (eligibleAgents <= 0) return 'gap';
  if (eligibleAgents === 1) return 'single_point';
  return 'healthy';
}

// ── Duration statistics (no fabricated durations; item 15) ────────────────────
export type DurationStats = { count: number; medianMs: number | null; averageMs: number | null };

/** Median (preferred, outlier-robust) + average over VALID durations only. Empty → nulls. */
export function durationStats(durationsMs: number[]): DurationStats {
  const valid = durationsMs.filter((d) => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
  if (valid.length === 0) return { count: 0, medianMs: null, averageMs: null };
  const mid = Math.floor(valid.length / 2);
  const medianMs = valid.length % 2 === 1 ? valid[mid] : Math.round((valid[mid - 1] + valid[mid]) / 2);
  const averageMs = Math.round(valid.reduce((s, d) => s + d, 0) / valid.length);
  return { count: valid.length, medianMs, averageMs };
}

/** completed / (completed + failed) — the terminal completion rate, or null when no terminal work. */
export function completionRate(completed: number, failed: number): number | null {
  const total = completed + failed;
  return total === 0 ? null : Math.round((completed / total) * 100) / 100;
}

// ── Insight shapes (SAFE: identifiers + labels + counts + timings only) ────────
export type MissionHealthRow = {
  missionId: string;
  title: string;
  status: MissionStatus;
  total: number; // non-cancelled tasks
  completed: number;
  failed: number;
  progress: number; // completed / total (non-cancelled); 0 when no tasks
};

export type StaleTask = {
  taskId: string;
  title: string;
  missionId: string;
  status: CompanyTaskStatus;
  ageMs: number;
  thresholdMs: number;
};

export type WorkHealthInsight = {
  queued: number;
  assigned: number;
  running: number;
  waitingDependency: number;
  waitingApproval: number;
  completedInWindow: number;
  failedInWindow: number;
  activeMissions: number;
  blockedMissions: number;
  missionsWithFailures: number;
  completedMissionsInWindow: number;
  staleTasks: StaleTask[];
  missions: MissionHealthRow[];
};

export type CapabilityCoverage = {
  capabilityId: string;
  requiredByTasks: number; // active (non-terminal) tasks currently requiring it
  eligibleAgents: number;
  coverageStatus: CoverageStatus;
  gapEventsInWindow: number; // CAPABILITY_GAP events touching a task that requires it
  temporaryAgentsInWindow: number; // factory agents promoted in-window granting it
};

export type CapabilityInsight = {
  capabilities: CapabilityCoverage[];
  gaps: number;
  singlePoints: number;
  healthy: number;
  unresolvedGapTasks: number; // active tasks with ≥1 required capability that has 0 eligible agents
  capabilityGapEventsInWindow: number;
  temporaryAgentsInWindow: number;
};

export type WorkflowCluster = {
  workflowId: string;
  name: string;
  runs: number;
  failures: number;
  rate: number; // failures / runs
};

export type RepeatedFailure = { taskId: string; title: string; missionId: string; failures: number };

export type ExecutionInsight = {
  tasksCompleted: number;
  tasksFailed: number;
  completionRate: number | null;
  directAgentExecutions: number;
  workflowExecutions: number;
  taskDuration: DurationStats;
  longRunningTasks: number;
  workflowRuns: number;
  workflowRunsSucceeded: number;
  workflowRunsFailed: number;
  workflowFailureRate: number | null;
};

export type DelayedApproval = { approvalId: string; title: string; taskId?: string; missionId?: string; waitMs: number };

export type ApprovalInsight = {
  pending: number;
  oldestPendingAgeMs: number | null;
  resolvedInWindow: number;
  averageResolvedWaitMs: number | null;
  tasksWaitingApproval: number;
};

export const AGENT_PRESENCE_STATES = ['idle', 'working', 'waiting_approval', 'failed'] as const;
export type AgentPresenceState = (typeof AGENT_PRESENCE_STATES)[number];

export type AgentInsight = {
  agentId: string;
  name: string;
  activeAssignments: number; // assigned/running/waiting company tasks pointing at this agent
  recentAssignments: number; // assignments touched within the window
  completedTasks: number; // completed in-window
  failedTasks: number; // failed in-window
  currentPresence: AgentPresenceState;
};

// ── Signals (closed, explainable; no arbitrary/LLM-generated types) ───────────
export const SIGNAL_TYPES = [
  'stale_task',
  'blocked_mission',
  'capability_gap',
  'single_point_capability',
  'approval_delay',
  'repeated_failure',
  'agent_overload',
  'workflow_failure_cluster',
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export const SIGNAL_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];

export type SignalEvidence = { kind: string; id: string; label?: string };
export type SignalMetric = { name: string; value: number; unit?: string };

export type IntelligenceSignal = {
  id: string; // deterministic + stable (dedup key)
  type: SignalType;
  severity: SignalSeverity;
  title: string;
  summary: string;
  evidence: SignalEvidence[];
  metric?: SignalMetric;
  threshold?: SignalMetric;
};

const SEVERITY_RANK: Record<SignalSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Coarse relative-age label for explainable summaries (no fake precision). */
function ageLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export type SignalInputs = {
  staleTasks: StaleTask[];
  missions: MissionHealthRow[]; // blocked_mission derived from these
  capabilities: CapabilityCoverage[]; // capability_gap + single_point derived from these
  delayedApprovals: DelayedApproval[];
  repeatedFailures: RepeatedFailure[];
  agents: AgentInsight[]; // agent_overload derived from these
  workflowClusters: WorkflowCluster[];
};

/**
 * Deterministic signal derivation (item 10 — rules over data, no LLM). Every signal
 * is explainable: it carries evidence pointing at the canonical object and, where a
 * rule has a threshold, the threshold that fired it. Ids are stable + deduplicated;
 * output is sorted by severity then type then id.
 */
export function deriveSignals(input: SignalInputs): IntelligenceSignal[] {
  const byId = new Map<string, IntelligenceSignal>();
  const add = (s: IntelligenceSignal): void => {
    if (!byId.has(s.id)) byId.set(s.id, s);
  };

  for (const t of input.staleTasks) {
    add({
      id: `stale_task:${t.taskId}`,
      type: 'stale_task',
      severity: 'warning',
      title: 'Task waiting too long',
      summary: `"${t.title}" has been ${t.status.replace(/_/g, ' ')} for ${ageLabel(t.ageMs)} (threshold ${ageLabel(t.thresholdMs)}).`,
      evidence: [{ kind: 'company_task', id: t.taskId, label: t.title }],
      metric: { name: 'age', value: t.ageMs, unit: 'ms' },
      threshold: { name: 'stale', value: t.thresholdMs, unit: 'ms' },
    });
  }

  for (const m of input.missions) {
    if (m.status !== 'blocked') continue;
    add({
      id: `blocked_mission:${m.missionId}`,
      type: 'blocked_mission',
      severity: 'warning',
      title: 'Mission blocked',
      summary: `"${m.title}" is blocked (${m.completed}/${m.total} tasks complete${m.failed ? `, ${m.failed} failed` : ''}).`,
      evidence: [{ kind: 'mission', id: m.missionId, label: m.title }],
    });
  }

  for (const c of input.capabilities) {
    if (c.requiredByTasks <= 0) continue; // only signal on capabilities work actually needs
    if (c.coverageStatus === 'gap') {
      add({
        id: `capability_gap:${c.capabilityId}`,
        type: 'capability_gap',
        severity: 'critical',
        title: 'Capability gap',
        summary: `No agent can satisfy "${c.capabilityId}", required by ${c.requiredByTasks} task(s).`,
        evidence: [{ kind: 'capability', id: c.capabilityId, label: c.capabilityId }],
        metric: { name: 'eligibleAgents', value: c.eligibleAgents },
      });
    } else if (c.coverageStatus === 'single_point') {
      add({
        id: `single_point_capability:${c.capabilityId}`,
        type: 'single_point_capability',
        severity: 'warning',
        title: 'Single-point capability',
        summary: `Only one agent can satisfy "${c.capabilityId}", required by ${c.requiredByTasks} task(s).`,
        evidence: [{ kind: 'capability', id: c.capabilityId, label: c.capabilityId }],
        metric: { name: 'eligibleAgents', value: 1 },
      });
    }
  }

  for (const a of input.delayedApprovals) {
    add({
      id: `approval_delay:${a.approvalId}`,
      type: 'approval_delay',
      severity: 'warning',
      title: 'Approval delay',
      summary: `"${a.title}" has been waiting ${ageLabel(a.waitMs)} for approval (threshold ${ageLabel(INTEL_THRESHOLDS.longApprovalWaitMs)}).`,
      evidence: [
        { kind: 'approval', id: a.approvalId, label: a.title },
        ...(a.taskId ? [{ kind: 'company_task', id: a.taskId } as SignalEvidence] : []),
      ],
      metric: { name: 'wait', value: a.waitMs, unit: 'ms' },
      threshold: { name: 'longApprovalWait', value: INTEL_THRESHOLDS.longApprovalWaitMs, unit: 'ms' },
    });
  }

  for (const r of input.repeatedFailures) {
    add({
      id: `repeated_failure:${r.taskId}`,
      type: 'repeated_failure',
      severity: 'critical',
      title: 'Repeated failure',
      summary: `"${r.title}" failed ${r.failures} times (threshold ${INTEL_THRESHOLDS.repeatedFailureCount}).`,
      evidence: [{ kind: 'company_task', id: r.taskId, label: r.title }],
      metric: { name: 'failures', value: r.failures },
      threshold: { name: 'repeatedFailure', value: INTEL_THRESHOLDS.repeatedFailureCount },
    });
  }

  for (const a of input.agents) {
    if (a.activeAssignments < INTEL_THRESHOLDS.agentActiveTaskWarning) continue;
    add({
      id: `agent_overload:${a.agentId}`,
      type: 'agent_overload',
      severity: 'warning',
      title: 'Agent overloaded',
      summary: `${a.name} has ${a.activeAssignments} active assignments (threshold ${INTEL_THRESHOLDS.agentActiveTaskWarning}).`,
      evidence: [{ kind: 'agent', id: a.agentId, label: a.name }],
      metric: { name: 'activeAssignments', value: a.activeAssignments },
      threshold: { name: 'agentActiveTaskWarning', value: INTEL_THRESHOLDS.agentActiveTaskWarning },
    });
  }

  for (const w of input.workflowClusters) {
    add({
      id: `workflow_failure_cluster:${w.workflowId}`,
      type: 'workflow_failure_cluster',
      severity: 'warning',
      title: 'Workflow failing repeatedly',
      summary: `"${w.name}" failed ${w.failures}/${w.runs} runs (${Math.round(w.rate * 100)}%).`,
      evidence: [{ kind: 'workflow', id: w.workflowId, label: w.name }],
      metric: { name: 'failureRate', value: Math.round(w.rate * 100), unit: '%' },
      threshold: { name: 'workflowFailureClusterRate', value: Math.round(INTEL_THRESHOLDS.workflowFailureClusterRate * 100), unit: '%' },
    });
  }

  return [...byId.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

// ── Top-level snapshot ────────────────────────────────────────────────────────
export type CompanyIntelligenceSnapshot = {
  generatedAt: string;
  window: { from: string; to: string; key: IntelWindowKey };
  workHealth: WorkHealthInsight;
  capabilityHealth: CapabilityInsight;
  executionHealth: ExecutionInsight;
  approvalHealth: ApprovalInsight;
  agentHealth: AgentInsight[];
  signals: IntelligenceSignal[];
};
