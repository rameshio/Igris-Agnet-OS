/**
 * Approval Decision Card — pure presentation model (UX Foundation U5, Part A).
 *
 * Turns a persisted Phase-E `FlowApproval` into a trustworthy DECISION view that
 * answers, at a glance: what is requesting permission, why approval is required,
 * what approve/reject each do, where it came from, and what the risk is.
 *
 * This module is a read-only PROJECTION — it is NOT a second source of truth and
 * it NEVER exposes the raw `context_json` blob or any secret/payload field. The
 * view is built from the safe, non-secret columns only (title/message are already
 * the operator-facing labels shown by the existing inbox; see docs/SECURITY.md).
 *
 * Pure + framework-free (no DB, no React) so the whole projection — including the
 * conservative risk heuristic — is unit-testable.
 */
import type { WorkflowGraph } from '@/lib/flows/schema';
import type { ApprovalRequestType, ApprovalStatus, FlowApproval } from '@/lib/flows/run-types';

export type ApprovalRisk = 'low' | 'medium' | 'high';

/**
 * What (if anything) is known to happen AFTER the approve route — the single
 * driver of downstream risk. Derived from the immutable version graph:
 *  - `external` → a tool node or an external `output` (notify/send) is reachable
 *  - `agent`    → an agent node is reachable (may call tools — effect not fully known)
 *  - `internal` → only internal nodes (decision/transform/join/display/save/draft)
 *  - `unknown`  → the version graph could not be loaded (never guessed as low)
 */
export type DownstreamEffect = 'internal' | 'agent' | 'external' | 'unknown';

export type ApprovalDecisionView = {
  approvalId: string;
  status: ApprovalStatus;
  /** status !== 'pending' — the card is history; approve/reject actions are disabled. */
  resolved: boolean;

  requestType: ApprovalRequestType;
  title: string;
  /** Non-secret operator label (already surfaced by the Phase-E inbox). Never context_json. */
  message?: string;

  workflowId: string;
  workflowVersion: number;
  workflowName?: string;
  runId: string;
  nodeId: string;
  nodeRunId?: string;

  /** Route handle labels a decision activates (approve edge / reject edge). */
  approveRoute: string;
  rejectRoute: string;
  approveEffect: string;
  rejectEffect: string;

  risk: ApprovalRisk;
  riskReason: string;

  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
};

/**
 * The ONLY approval fields the view is built from. Deliberately OMITS `context`
 * (the parsed context_json) so a raw blob can never leak into the projection —
 * enforced by tests.
 */
export type ApprovalViewInput = Pick<
  FlowApproval,
  | 'id'
  | 'status'
  | 'requestType'
  | 'title'
  | 'message'
  | 'workflowId'
  | 'workflowVersion'
  | 'runId'
  | 'nodeId'
  | 'nodeRunId'
  | 'approvalRoute'
  | 'rejectionRoute'
  | 'requestedAt'
  | 'resolvedAt'
  | 'resolvedBy'
  | 'resolutionNote'
>;

// ── Risk heuristic (conservative; never under-claimed) ───────────────────────

const RISK_ORDER: ApprovalRisk[] = ['low', 'medium', 'high'];
function maxRisk(a: ApprovalRisk, b: ApprovalRisk): ApprovalRisk {
  return RISK_ORDER[Math.max(RISK_ORDER.indexOf(a), RISK_ORDER.indexOf(b))];
}

/**
 * A per-request-type floor. Native workflow gates start `low` (risk comes from
 * what follows); more privileged request kinds carry an inherent floor so they
 * can never read as low. Unknown kinds fall back to `medium`, never lower.
 */
const REQUEST_TYPE_FLOOR: Record<ApprovalRequestType, ApprovalRisk> = {
  workflow: 'low',
  hermes: 'medium',
  tool: 'high',
  sudo: 'high',
  secret: 'high',
};

/**
 * Deterministic, non-overclaiming risk. Combines the request-type floor with the
 * downstream effect; the HIGHER of the two wins so risk is never under-claimed.
 * Ambiguity (unknown downstream) resolves to `medium`, never a guessed `low`.
 */
export function approvalRisk(
  requestType: ApprovalRequestType,
  downstream: DownstreamEffect,
): { risk: ApprovalRisk; reason: string } {
  const floor = REQUEST_TYPE_FLOOR[requestType] ?? 'medium';

  let downstreamRisk: ApprovalRisk;
  let downstreamReason: string;
  switch (downstream) {
    case 'external':
      downstreamRisk = 'high';
      downstreamReason = 'external action may follow';
      break;
    case 'agent':
      downstreamRisk = 'medium';
      downstreamReason = 'an agent runs downstream (effect not fully known)';
      break;
    case 'internal':
      downstreamRisk = 'low';
      downstreamReason = 'internal continuation only';
      break;
    case 'unknown':
    default:
      downstreamRisk = 'medium';
      downstreamReason = 'downstream effect could not be determined';
      break;
  }

  const risk = maxRisk(floor, downstreamRisk);
  // Report the factor that actually drove the level.
  const reason =
    RISK_ORDER.indexOf(floor) > RISK_ORDER.indexOf(downstreamRisk)
      ? `${requestType} request`
      : downstreamReason;
  return { risk, reason };
}

/**
 * Classify what happens after the approve route by walking the immutable version
 * graph from the approval node. Conservative: edges leaving the approval node
 * with the approve handle (or NO handle — ambiguous, so counted) are followed;
 * reaching a tool node or an external `output` (notify) ⇒ `external`; an agent
 * node ⇒ `agent`; otherwise `internal`. A missing graph ⇒ `unknown`.
 */
export function classifyDownstream(
  graph: WorkflowGraph | null | undefined,
  approvalNodeId: string,
  approveRoute: string,
): DownstreamEffect {
  if (!graph) return 'unknown';

  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const startTargets = graph.edges
    .filter((e) => e.source === approvalNodeId && (e.sourceHandle === approveRoute || e.sourceHandle == null || e.sourceHandle === ''))
    .map((e) => e.target);

  const seen = new Set<string>();
  const queue = [...startTargets];
  let sawExternal = false;
  let sawAgent = false;

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodesById.get(id);
    if (!node) continue;

    if (node.type === 'tool') {
      sawExternal = true;
    } else if (node.type === 'output') {
      const mode = (node.config as { mode?: string } | undefined)?.mode;
      if (mode === 'notify') sawExternal = true; // notify = external send; display/save/draft are internal
    } else if (node.type === 'agent') {
      sawAgent = true;
    }

    for (const e of graph.edges) if (e.source === id) queue.push(e.target);
  }

  if (sawExternal) return 'external';
  if (sawAgent) return 'agent';
  return 'internal';
}

// ── View builder ─────────────────────────────────────────────────────────────

/**
 * Build the decision card from the safe approval subset + resolved context. Never
 * reads `context_json`. `downstream` is supplied by the service (which owns the
 * version-graph lookup) so this stays pure and testable.
 */
export function buildApprovalDecisionView(
  a: ApprovalViewInput,
  ctx: { workflowName?: string; downstream: DownstreamEffect },
): ApprovalDecisionView {
  const { risk, reason } = approvalRisk(a.requestType, ctx.downstream);
  return {
    approvalId: a.id,
    status: a.status,
    resolved: a.status !== 'pending',
    requestType: a.requestType,
    title: a.title,
    message: a.message?.trim() ? a.message : undefined,
    workflowId: a.workflowId,
    workflowVersion: a.workflowVersion,
    workflowName: ctx.workflowName?.trim() || undefined,
    runId: a.runId,
    nodeId: a.nodeId,
    nodeRunId: a.nodeRunId ?? undefined,
    approveRoute: a.approvalRoute,
    rejectRoute: a.rejectionRoute,
    approveEffect: `Continue via "${a.approvalRoute}" route`,
    rejectEffect: `Continue via "${a.rejectionRoute}" route`,
    risk,
    riskReason: reason,
    requestedAt: a.requestedAt,
    resolvedAt: a.resolvedAt ?? undefined,
    resolvedBy: a.resolvedBy ?? undefined,
    resolutionNote: a.resolutionNote ?? undefined,
  };
}
