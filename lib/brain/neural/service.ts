/**
 * G-Brain Neural — service (Architecture V2 · F5).
 *
 * `getNeuralGraph` projects the live/recent operational graph over a bounded time window.
 * Edges + timestamps come from the F1 `company_events` ledger; node STATUS comes from CURRENT
 * canonical state (task/mission/run/approval/presence) — never from event replay. It is
 * READ-ONLY (no writes to any table), bounded (window + node/edge caps), and safe (identifiers +
 * labels + coarse status only — never prompts, tokens, `context_json`, inputs, or outputs).
 */
import type { FounderDb } from '@/lib/db';
import type { CompanyEvent } from '@/lib/company/manager/model';
import { BrainError } from '@/lib/brain/core/model';
import { parseEntityRef, type ParsedRef } from '@/lib/brain/projection/model';
import { getMission, getCompanyTask } from '@/lib/company/service';
import { getAgentById } from '@/lib/agents/registry';
import { getArtifact } from '@/lib/company/manager/artifacts';
import { buildAgentPresence } from '@/lib/agents/presence-service';
import {
  clampNeuralLimit,
  edgeId,
  isActiveStatus,
  mapApprovalStatus,
  mapMissionStatus,
  mapRunStatus,
  mapTaskStatus,
  nodeKey,
  parseWindow,
  projectionForEvent,
  NEURAL_MAX_EDGES,
  NEURAL_MAX_NODES,
  type NeuralEdge,
  type NeuralEdgeType,
  type NeuralGraph,
  type NeuralNode,
  type NeuralNodeKind,
  type NeuralStatus,
} from '@/lib/brain/neural/model';

type Ctx = { db: FounderDb; nodes: Map<string, NeuralNode>; edges: Map<string, NeuralEdge>; markTruncated: () => void };

/** Add a node if absent (respecting the node cap). Sets occurredAt on first (newest) touch. */
function addNode(ctx: Ctx, node: NeuralNode): NeuralNode | null {
  const existing = ctx.nodes.get(node.id);
  if (existing) return existing;
  if (ctx.nodes.size >= NEURAL_MAX_NODES) {
    ctx.markTruncated();
    return null;
  }
  ctx.nodes.set(node.id, node);
  return node;
}
function addEdge(ctx: Ctx, from: string, to: string, type: NeuralEdgeType, occurredAt: string): void {
  const id = edgeId(from, to, type);
  if (ctx.edges.has(id)) return;
  if (ctx.edges.size >= NEURAL_MAX_EDGES) {
    ctx.markTruncated();
    return;
  }
  ctx.edges.set(id, { id, from, to, type, occurredAt });
}

// ── Node builders (safe labels only) ─────────────────────────────────────────
const missionNode = (db: FounderDb, id: string, at: string): NeuralNode => ({ id: nodeKey('mission', id), kind: 'mission', label: getMission(db, id)?.title ?? `mission ${id.slice(0, 8)}`, canonicalRef: { kind: 'mission', id }, occurredAt: at, active: false });
const taskNode = (db: FounderDb, id: string, at: string): NeuralNode => ({ id: nodeKey('company_task', id), kind: 'task', label: getCompanyTask(db, id)?.title ?? `task ${id.slice(0, 8)}`, canonicalRef: { kind: 'company_task', id }, occurredAt: at, active: false });
const agentNode = (db: FounderDb, id: string, at: string): NeuralNode => ({ id: nodeKey('agent', id), kind: 'agent', label: getAgentById(db, id)?.name ?? id, canonicalRef: { kind: 'agent', id }, occurredAt: at, active: false });
const artifactNode = (db: FounderDb, id: string, at: string): NeuralNode => ({ id: nodeKey('artifact', id), kind: 'artifact', label: getArtifact(db, id)?.title ?? `artifact ${id.slice(0, 8)}`, canonicalRef: { kind: 'artifact', id }, occurredAt: at, active: false });
const workflowRunNode = (db: FounderDb, runId: string, workflowId: string | undefined, at: string): NeuralNode => {
  const wfName = workflowId ? db.flowWorkflows.get(workflowId)?.name : undefined;
  return { id: nodeKey('workflow_run', runId), kind: 'workflow_run', label: `${wfName ?? 'workflow'} · run`, canonicalRef: { kind: 'workflow_run', id: runId }, occurredAt: at, active: false };
};
const approvalNode = (id: string, at: string): NeuralNode => ({ id: nodeKey('approval', id), kind: 'approval', label: `Approval ${id.slice(0, 8)}`, canonicalRef: { kind: 'approval', id }, occurredAt: at, active: false });
const eventNode = (ev: CompanyEvent): NeuralNode => ({ id: nodeKey('event', ev.id), kind: 'event', label: ev.type.replace(/_/g, ' ').toLowerCase(), subtitle: ev.summary.slice(0, 80), canonicalRef: { kind: 'event', id: ev.id }, occurredAt: ev.createdAt, active: false });

/** Resolve the real flow approval id for a workflow-executed task waiting on a human, or null. */
function approvalIdForTask(db: FounderDb, taskId: string): string | null {
  const t = getCompanyTask(db, taskId);
  if (!t || t.executionKind !== 'workflow' || !t.executionRefId) return null;
  const approvals = db.flowApprovals.forRun(t.executionRefId);
  return approvals.length ? approvals[approvals.length - 1].id : null;
}

/** Build nodes + edges from ONE ledger event (newest-first processing; never fabricates missing refs). */
function buildFromEvent(ctx: Ctx, ev: CompanyEvent): void {
  const at = ev.createdAt;
  const proj = projectionForEvent(ev.type);

  if (proj === 'status') {
    if (ev.taskId) addNode(ctx, taskNode(ctx.db, ev.taskId, at));
    else if (ev.missionId) addNode(ctx, missionNode(ctx.db, ev.missionId, at));
    return;
  }
  if (proj === 'event') {
    const en = addNode(ctx, eventNode(ev));
    if (!en) return;
    if (ev.taskId) { const t = addNode(ctx, taskNode(ctx.db, ev.taskId, at)); if (t) addEdge(ctx, t.id, en.id, 'handoff', at); }
    else if (ev.missionId) { const m = addNode(ctx, missionNode(ctx.db, ev.missionId, at)); if (m) addEdge(ctx, m.id, en.id, 'handoff', at); }
    return;
  }

  // Edge spec: resolve both endpoints from the event's refs (skip if an endpoint is missing).
  const resolve = (kind: NeuralNodeKind): NeuralNode | null => {
    switch (kind) {
      case 'mission': return ev.missionId ? addNode(ctx, missionNode(ctx.db, ev.missionId, at)) : null;
      case 'task': return ev.taskId ? addNode(ctx, taskNode(ctx.db, ev.taskId, at)) : null;
      case 'agent': return ev.agentId ? addNode(ctx, agentNode(ctx.db, ev.agentId, at)) : null;
      case 'artifact': return ev.artifactId ? addNode(ctx, artifactNode(ctx.db, ev.artifactId, at)) : null;
      case 'workflow_run': {
        const runId = typeof ev.metadata?.runId === 'string' ? ev.metadata.runId : undefined;
        return runId ? addNode(ctx, workflowRunNode(ctx.db, runId, ev.workflowId, at)) : null;
      }
      case 'approval': {
        if (!ev.taskId) return null;
        const approvalId = approvalIdForTask(ctx.db, ev.taskId);
        return approvalId ? addNode(ctx, approvalNode(approvalId, at)) : null;
      }
      default: return null;
    }
  };
  const fromNode = resolve(proj.from);
  const toNode = resolve(proj.to);
  if (fromNode && toNode) addEdge(ctx, fromNode.id, toNode.id, proj.edge, at);
}

/** Reconcile each node's status/active from CURRENT canonical state (never event replay). */
function reconcileStatuses(db: FounderDb, nodes: Map<string, NeuralNode>): void {
  const presence = new Map(buildAgentPresence(db).map((p) => [p.agentId, p.state]));
  for (const n of nodes.values()) {
    let status: NeuralStatus | undefined;
    const id = n.canonicalRef?.id;
    switch (n.kind) {
      case 'mission': { const m = id ? getMission(db, id) : null; if (m) status = mapMissionStatus(m.status); break; }
      case 'task': { const t = id ? getCompanyTask(db, id) : null; if (t) status = mapTaskStatus(t.status); break; }
      case 'workflow_run': { const r = id ? db.flowRuns.get(id) : null; if (r) status = mapRunStatus(r.status); break; }
      case 'approval': { const a = id ? db.flowApprovals.get(id) : null; if (a) status = mapApprovalStatus(a.status); break; }
      case 'agent': { const st = id ? presence.get(id) : undefined; status = st === 'working' ? 'running' : st === 'waiting_approval' ? 'waiting_approval' : st === 'failed' ? 'failed' : 'idle'; break; }
      case 'artifact': status = 'completed'; break;
      case 'event': status = undefined; break;
    }
    n.status = status;
    n.active = isActiveStatus(status);
  }
}

/** Keep only events touching the focus root (mission → its own events, which carry the missionId). */
function filterForRoot(events: CompanyEvent[], ref: ParsedRef): CompanyEvent[] {
  switch (ref.kind) {
    case 'mission': return events.filter((e) => e.missionId === ref.id);
    case 'company_task': return events.filter((e) => e.taskId === ref.id);
    case 'agent': return events.filter((e) => e.agentId === ref.id);
    case 'workflow': return events.filter((e) => e.workflowId === ref.id);
    case 'artifact': return events.filter((e) => e.artifactId === ref.id);
    default: return []; // knowledge/source/brain_entity are structural, not operational
  }
}

function rootKey(ref: ParsedRef): string | undefined {
  switch (ref.kind) {
    case 'mission': return nodeKey('mission', ref.id);
    case 'company_task': return nodeKey('company_task', ref.id);
    case 'agent': return nodeKey('agent', ref.id);
    case 'workflow': return nodeKey('workflow', ref.id);
    case 'artifact': return nodeKey('artifact', ref.id);
    default: return undefined;
  }
}

export function getNeuralGraph(db: FounderDb, opts: { entity?: string; window?: string; limit?: number } = {}): NeuralGraph {
  const { minutes } = parseWindow(opts.window);
  const now = new Date();
  const from = new Date(now.getTime() - minutes * 60_000).toISOString();
  const to = now.toISOString();
  const maxEvents = clampNeuralLimit(opts.limit);

  let root: ParsedRef | null = null;
  if (opts.entity) {
    root = parseEntityRef(opts.entity);
    if (!root) throw new BrainError('invalid entity reference', 400);
  }

  let events = db.companyEvents.since(from, maxEvents);
  let truncated = events.length >= maxEvents;
  if (root) events = filterForRoot(events, root);

  const nodes = new Map<string, NeuralNode>();
  const edges = new Map<string, NeuralEdge>();
  const ctx: Ctx = { db, nodes, edges, markTruncated: () => { truncated = true; } };

  for (const ev of events) buildFromEvent(ctx, ev); // newest-first

  reconcileStatuses(db, nodes);

  const survivingEdges = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));
  return { root: root ? rootKey(root) : undefined, nodes: [...nodes.values()], edges: survivingEdges, generatedAt: to, window: { from, to }, truncated };
}
