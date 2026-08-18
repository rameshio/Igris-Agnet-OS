/**
 * IGRIS Activity / Ops Stream — pure view model (UX Foundation U4).
 *
 * A read-only OPERATIONAL PROJECTION over authoritative run/approval state. It is
 * NOT a second source of truth and it never stores or exposes payloads: an
 * ActivityEvent carries identifiers + safe labels + a coarse status only —
 * never secrets, tokens, prompts, LLM outputs, tool arguments, email bodies, or
 * raw context_json.
 *
 * This module is pure + framework-free (no DB, no fetch, no React) so the whole
 * normalization is unit-testable. The service layer (lib/activity/service.ts)
 * loads bounded rows from the repositories, maps them to the small `*Lite`
 * shapes below, and calls these builders.
 */

export type ActivityCategory = 'workflow' | 'agent' | 'approval' | 'error' | 'system';

export type ActivityEvent = {
  /** Stable across polls (so React keys don't churn): `${source}:${sourceId}:${kind}`. */
  id: string;
  timestamp: string; // ISO 8601
  category: ActivityCategory;
  kind: string;
  status?: string;
  title: string;
  detail?: string;
  // Identifiers only — for navigation + later Context Envelope grounding.
  workflowId?: string;
  runId?: string;
  nodeRunId?: string;
  agentId?: string;
  approvalId?: string;
};

// ── Filters (presentation only) ──────────────────────────────────────────────

export const ACTIVITY_FILTERS = ['all', 'flows', 'agents', 'approvals', 'errors'] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

/** Bounded feed size — the API clamps `limit` to this. */
export const ACTIVITY_MAX_LIMIT = 200;
export const ACTIVITY_DEFAULT_LIMIT = 50;

/** Poll cadence for the panel (modest; no WebSockets in U4). */
export const ACTIVITY_POLL_MS = 6000;

// ── Safe input DTOs (what the service passes in — no payload fields exist here) ──

export type RunLite = {
  id: string;
  workflowId: string;
  workflowName?: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
};

export type ApprovalLite = {
  id: string;
  runId: string;
  workflowId: string;
  workflowName?: string;
  status: string;
  title: string; // configured, non-secret label
  requestedAt: string;
  resolvedAt: string | null;
};

export type NodeRunLite = {
  id: string;
  runId: string;
  workflowId?: string;
  workflowName?: string;
  nodeId: string;
  nodeType: string;
  status: string;
  /** Resolved (authoritatively, from the version graph) — absent when not reliably known. */
  agentId?: string;
  agentName?: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  errorMessage: string | null;
};

// Error messages are short operator labels, never payloads — but cap length so a
// verbose provider error can never balloon the stream or smuggle a blob through.
const DETAIL_MAX = 160;
function safeDetail(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX - 1)}…` : t;
}

function wfLabel(run: { workflowName?: string; workflowId: string }): string {
  return run.workflowName?.trim() || run.workflowId;
}

// ── Builders (one authoritative row → 0..2 events) ───────────────────────────

/**
 * A run yields a `started` event (always, once it has any timestamp) plus a
 * terminal event derived from its status. Failures are categorized as `error`.
 */
export function eventsForRun(run: RunLite): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  const label = wfLabel(run);
  const startedTs = run.startedAt ?? run.createdAt;

  out.push({
    id: `run:${run.id}:started`,
    timestamp: startedTs,
    category: 'workflow',
    kind: 'run_started',
    status: run.status,
    title: `${label} started`,
    workflowId: run.workflowId,
    runId: run.id,
  });

  const terminalTs = run.endedAt ?? run.updatedAt;
  switch (run.status) {
    case 'success':
      out.push({
        id: `run:${run.id}:completed`,
        timestamp: terminalTs,
        category: 'workflow',
        kind: 'run_completed',
        status: 'success',
        title: `${label} completed`,
        workflowId: run.workflowId,
        runId: run.id,
      });
      break;
    case 'failed':
      out.push({
        id: `run:${run.id}:failed`,
        timestamp: terminalTs,
        category: 'error',
        kind: 'run_failed',
        status: 'failed',
        title: `${label} failed`,
        detail: safeDetail(run.errorMessage) ?? safeDetail(run.errorCode),
        workflowId: run.workflowId,
        runId: run.id,
      });
      break;
    case 'interrupted':
      out.push({
        id: `run:${run.id}:interrupted`,
        timestamp: terminalTs,
        category: 'error',
        kind: 'run_interrupted',
        status: 'interrupted',
        title: `${label} interrupted`,
        workflowId: run.workflowId,
        runId: run.id,
      });
      break;
    case 'waiting_approval':
      out.push({
        id: `run:${run.id}:waiting`,
        timestamp: terminalTs,
        category: 'workflow',
        kind: 'run_waiting_approval',
        status: 'waiting_approval',
        title: `${label} waiting for approval`,
        workflowId: run.workflowId,
        runId: run.id,
      });
      break;
    case 'canceled':
      out.push({
        id: `run:${run.id}:canceled`,
        timestamp: terminalTs,
        category: 'workflow',
        kind: 'run_canceled',
        status: 'canceled',
        title: `${label} canceled`,
        workflowId: run.workflowId,
        runId: run.id,
      });
      break;
    // queued / running → only the started event (no fabricated terminal state)
    default:
      break;
  }
  return out;
}

/** An approval yields a `requested` event and, once resolved, an approved/rejected event. */
export function eventsForApproval(a: ApprovalLite): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  const label = a.workflowName?.trim() || a.workflowId;
  const reqTitle = a.title?.trim() ? a.title.trim() : `${label} · approval required`;

  out.push({
    id: `approval:${a.id}:requested`,
    timestamp: a.requestedAt,
    category: 'approval',
    kind: 'approval_requested',
    status: a.status === 'pending' ? 'pending' : 'requested',
    title: a.status === 'pending' ? `Approval required — ${reqTitle}` : `Approval requested — ${reqTitle}`,
    detail: label,
    workflowId: a.workflowId,
    runId: a.runId,
    approvalId: a.id,
  });

  if (a.resolvedAt && (a.status === 'approved' || a.status === 'rejected')) {
    out.push({
      id: `approval:${a.id}:${a.status}`,
      timestamp: a.resolvedAt,
      category: 'approval',
      kind: `approval_${a.status}`,
      status: a.status,
      title: `Approval ${a.status} — ${reqTitle}`,
      detail: label,
      workflowId: a.workflowId,
      runId: a.runId,
      approvalId: a.id,
    });
  }
  return out;
}

/**
 * Node runs are NOT surfaced wholesale (that would flood the stream). Only:
 *  - agent-node lifecycle when the agent is RELIABLY known (running/succeeded/failed), and
 *  - any node FAILURE (as an error event).
 * A failed agent node whose identity is known is surfaced as an agent failure;
 * everything else non-agent and non-failed is intentionally dropped.
 */
export function eventsForNodeRun(n: NodeRunLite): ActivityEvent[] {
  const label = n.workflowName?.trim() || n.workflowId || 'workflow';
  const isAgent = n.nodeType === 'agent' && !!n.agentId;
  const agentLabel = n.agentName?.trim() || n.agentId || 'Agent';
  const ts = n.endedAt ?? n.startedAt ?? n.createdAt;

  if (isAgent) {
    if (n.status === 'running') {
      return [{
        id: `node:${n.id}:agent_running`,
        timestamp: n.startedAt ?? n.createdAt,
        category: 'agent',
        kind: 'agent_running',
        status: 'running',
        title: `${agentLabel} running`,
        detail: label,
        workflowId: n.workflowId,
        runId: n.runId,
        nodeRunId: n.id,
        agentId: n.agentId,
      }];
    }
    if (n.status === 'success') {
      return [{
        id: `node:${n.id}:agent_completed`,
        timestamp: ts,
        category: 'agent',
        kind: 'agent_completed',
        status: 'success',
        title: `${agentLabel} completed`,
        detail: label,
        workflowId: n.workflowId,
        runId: n.runId,
        nodeRunId: n.id,
        agentId: n.agentId,
      }];
    }
    if (n.status === 'failed') {
      return [{
        id: `node:${n.id}:agent_failed`,
        timestamp: ts,
        category: 'error',
        kind: 'agent_failed',
        status: 'failed',
        title: `${agentLabel} failed`,
        detail: safeDetail(n.errorMessage) ?? label,
        workflowId: n.workflowId,
        runId: n.runId,
        nodeRunId: n.id,
        agentId: n.agentId,
      }];
    }
    return [];
  }

  // Non-agent node: surface failures only (no agent identity guessed).
  if (n.status === 'failed') {
    return [{
      id: `node:${n.id}:node_failed`,
      timestamp: ts,
      category: 'error',
      kind: 'node_failed',
      status: 'failed',
      title: `${label} · ${n.nodeType} failed`,
      detail: safeDetail(n.errorMessage),
      workflowId: n.workflowId,
      runId: n.runId,
      nodeRunId: n.id,
    }];
  }
  return [];
}

// ── Sort / filter / limit ────────────────────────────────────────────────────

/** Newest first; deterministic tiebreak by id DESC so equal timestamps never reorder between polls. */
export function sortEvents(events: ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
    if (a.id !== b.id) return a.id < b.id ? 1 : -1;
    return 0;
  });
}

const FILTER_CATEGORIES: Record<ActivityFilter, ActivityCategory[] | null> = {
  all: null,
  flows: ['workflow'],
  agents: ['agent'],
  approvals: ['approval'],
  errors: ['error'],
};

export function filterEvents(events: ActivityEvent[], filter: ActivityFilter): ActivityEvent[] {
  const cats = FILTER_CATEGORIES[filter];
  if (!cats) return events;
  return events.filter((e) => cats.includes(e.category));
}

/** Normalize a bag of events into the final feed: sort → filter → cap. */
export function buildFeed(
  events: ActivityEvent[],
  opts: { filter?: ActivityFilter; limit?: number } = {},
): ActivityEvent[] {
  const filter = opts.filter ?? 'all';
  const limit = Math.min(Math.max(opts.limit ?? ACTIVITY_DEFAULT_LIMIT, 1), ACTIVITY_MAX_LIMIT);
  return filterEvents(sortEvents(events), filter).slice(0, limit);
}

/** True when an event should be visually flagged as needing attention. */
export function isNeedsAttention(e: ActivityEvent): boolean {
  return e.category === 'error' || e.kind === 'run_waiting_approval' || (e.category === 'approval' && e.status === 'pending');
}

// ── Navigation (to existing canonical surfaces; no new routing architecture) ──

export function navHrefForEvent(e: ActivityEvent): string {
  if (e.category === 'approval') return '/approvals';
  if (e.category === 'agent') return '/agents';
  if (e.workflowId) return '/flows'; // /flows has no deep-link param yet — canonical surface
  return '/';
}

// ── Polling helper (extracted so overlap-prevention is unit-testable) ─────────

/** Only start a poll when the panel is open, mounted, and no request is in flight. */
export function canStartPoll(state: { open: boolean; mounted: boolean; inFlight: boolean }): boolean {
  return state.open && state.mounted && !state.inFlight;
}
