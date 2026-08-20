/**
 * G-Brain Radial projection — service (Architecture V2 · F4).
 *
 * `getRadialNeighborhood` resolves a root (a persisted BrainEntity, or a canonical ref
 * projected LIVE without persisting) and returns a BOUNDED graph of the root plus its
 * neighborhood. It combines PROJECTED canonical edges (Mission→Task, Task→Artifact/Agent/
 * dependency/capability, Artifact→Agent, Knowledge→Source, …) with PERSISTED G-Brain edges
 * (F3 `brain_relationships`). It NEVER writes: viewing a canonical object creates no
 * BrainEntity and no BrainRelationship. Projected edges are never written back to G-Brain.
 */
import type { FounderDb } from '@/lib/db';
import { BrainError } from '@/lib/brain/core/model';
import { getAgentById, getCapabilitiesForAgent } from '@/lib/agents/registry';
import { getMission, getCompanyTask, listTasksForMission, getTaskDependencies } from '@/lib/company/service';
import { getArtifact } from '@/lib/company/manager/artifacts';
import { getKnowledge } from '@/lib/brain/core/knowledge';
import {
  clampDepth,
  clampLimit,
  edgeId,
  nodeKey,
  parseEntityRef,
  radialKindForCanonical,
  RADIAL_MAX_EDGES,
  type BrainGraphEdge,
  type BrainGraphNode,
  type ParsedRef,
  type RadialEdgeType,
  type RadialGraph,
  type RadialNodeKind,
} from '@/lib/brain/projection/model';

// ── Node builders (safe fields only — never model/prompt/secret/tool creds) ──
const agentNode = (db: FounderDb, id: string): BrainGraphNode | null => {
  const a = getAgentById(db, id);
  if (!a) return null;
  return { id: nodeKey('agent', id), kind: 'agent', label: a.name, subtitle: a.role === 'executive_manager' ? 'Executive Manager' : a.departmentId, canonicalRef: { kind: 'agent', id }, expandable: true, persisted: false };
};
const missionNode = (db: FounderDb, id: string): BrainGraphNode | null => {
  const m = getMission(db, id);
  if (!m) return null;
  return { id: nodeKey('mission', id), kind: 'mission', label: m.title, status: m.status, canonicalRef: { kind: 'mission', id }, expandable: true, persisted: false };
};
const taskNode = (db: FounderDb, id: string): BrainGraphNode | null => {
  const t = getCompanyTask(db, id);
  if (!t) return null;
  return { id: nodeKey('company_task', id), kind: 'task', label: t.title, status: t.status, canonicalRef: { kind: 'company_task', id }, expandable: true, persisted: false };
};
const artifactNode = (db: FounderDb, id: string): BrainGraphNode | null => {
  const a = getArtifact(db, id);
  if (!a) return null;
  return { id: nodeKey('artifact', id), kind: 'artifact', label: a.title, subtitle: a.type, canonicalRef: { kind: 'artifact', id }, expandable: true, persisted: false };
};
const knowledgeNode = (db: FounderDb, id: string): BrainGraphNode | null => {
  const k = getKnowledge(db, id);
  if (!k) return null;
  return { id: nodeKey('knowledge', id), kind: 'knowledge', label: k.title, subtitle: k.kind, status: k.status, canonicalRef: { kind: 'knowledge', id }, expandable: true, persisted: false };
};
const workflowNode = (db: FounderDb, id: string): BrainGraphNode | null => {
  const w = db.flowWorkflows.get(id);
  if (!w) return null;
  return { id: nodeKey('workflow', id), kind: 'workflow', label: w.name, subtitle: w.currentVersion != null ? `v${w.currentVersion}` : 'draft', canonicalRef: { kind: 'workflow', id }, expandable: false, persisted: false };
};
const sourceNode = (db: FounderDb, id: string): BrainGraphNode | null => {
  const s = db.brainSources.get(id);
  if (!s) return null;
  return { id: nodeKey('source', id), kind: 'source', label: s.title ?? s.type, subtitle: s.type, canonicalRef: { kind: 'source', id }, expandable: true, persisted: false };
};
const capabilityNode = (capId: string): BrainGraphNode => ({ id: nodeKey('capability', capId), kind: 'capability', label: capId, expandable: false, persisted: false });
const departmentNode = (db: FounderDb, deptId: string): BrainGraphNode => {
  const d = db.departments.all().find((x) => x.id === deptId);
  return { id: nodeKey('department', deptId), kind: 'department', label: d?.name ?? deptId, expandable: false, persisted: false };
};

const mkEdge = (from: string, to: string, type: RadialEdgeType, persisted: boolean, label?: string): BrainGraphEdge => ({ id: edgeId(from, to, type), from, to, type, label, persisted });

// ── Persisted brain-entity → radial node ─────────────────────────────────────
function brainEntityToNode(db: FounderDb, entityId: string): BrainGraphNode | null {
  const e = db.brainEntities.get(entityId);
  if (!e) return null;
  if (e.canonicalRef) {
    const { keyKind, nodeKind } = radialKindForCanonical(e.canonicalRef.kind);
    return { id: nodeKey(keyKind, e.canonicalRef.id), kind: nodeKind, label: e.name, canonicalRef: e.canonicalRef, expandable: true, persisted: true };
  }
  return { id: nodeKey('concept', e.id), kind: (e.type as RadialNodeKind) ?? 'concept', label: e.name, expandable: true, persisted: true };
}

type Expansion = { nodes: BrainGraphNode[]; edges: BrainGraphEdge[] };

/** Persisted G-Brain edges for a node that has a canonical key (from F3 `brain_relationships`). */
function persistedEdgesFor(db: FounderDb, node: BrainGraphNode): Expansion {
  const nodes: BrainGraphNode[] = [];
  const edges: BrainGraphEdge[] = [];
  // Find the persisted brain entity for this node's canonical key (if any).
  const entity = db.brainEntities.getByCanonicalKey(node.id);
  if (!entity) return { nodes, edges };
  for (const rel of db.brainRelationships.forEntity(entity.id)) {
    const otherId = rel.fromEntityId === entity.id ? rel.toEntityId : rel.fromEntityId;
    const otherNode = brainEntityToNode(db, otherId);
    if (!otherNode) continue;
    nodes.push(otherNode);
    // Preserve direction of the persisted relationship.
    const fromKey = rel.fromEntityId === entity.id ? node.id : otherNode.id;
    const toKey = rel.toEntityId === entity.id ? node.id : otherNode.id;
    edges.push(mkEdge(fromKey, toKey, rel.type as RadialEdgeType, true));
  }
  return { nodes, edges };
}

/** Project the LIVE canonical neighborhood of a node (never persisted). */
function projectedExpansion(db: FounderDb, node: BrainGraphNode): Expansion {
  const nodes: BrainGraphNode[] = [];
  const edges: BrainGraphEdge[] = [];
  const push = <T extends BrainGraphNode | null>(n: T): T => { if (n) nodes.push(n); return n; };

  const ref = node.canonicalRef;
  const refKind = ref?.kind;
  const refId = ref?.id;

  if (refKind === 'mission' && refId) {
    for (const t of listTasksForMission(db, refId)) {
      const tn = push(taskNode(db, t.id));
      if (tn) edges.push(mkEdge(node.id, tn.id, 'HAS_TASK', false));
    }
  } else if (refKind === 'company_task' && refId) {
    const t = getCompanyTask(db, refId);
    if (t) {
      if (t.missionId) { const mn = push(missionNode(db, t.missionId)); if (mn) edges.push(mkEdge(mn.id, node.id, 'HAS_TASK', false)); }
      if (t.assignedAgentId) { const an = push(agentNode(db, t.assignedAgentId)); if (an) edges.push(mkEdge(node.id, an.id, 'ASSIGNED_TO', false)); }
      if (t.workflowId) { const wn = push(workflowNode(db, t.workflowId)); if (wn) edges.push(mkEdge(node.id, wn.id, 'USES_WORKFLOW', false)); }
      for (const cap of t.requiredCapabilities) { const cn = push(capabilityNode(cap)); edges.push(mkEdge(node.id, cn.id, 'REQUIRES', false)); }
      for (const a of db.companyArtifacts.forTask(refId)) { const an = push(artifactNode(db, a.id)); if (an) edges.push(mkEdge(node.id, an.id, 'PRODUCED', false)); }
      for (const dep of getTaskDependencies(db, refId).dependsOn) { const dn = push(taskNode(db, dep.id)); if (dn) edges.push(mkEdge(node.id, dn.id, 'DEPENDS_ON', false)); }
    }
  } else if (refKind === 'agent' && refId) {
    const a = getAgentById(db, refId);
    if (a) {
      if (a.departmentId) { const dn = push(departmentNode(db, a.departmentId)); edges.push(mkEdge(node.id, dn.id, 'IN_DEPARTMENT', false)); }
      const parentId = (a as { parentId?: string | null }).parentId;
      if (parentId) { const pn = push(agentNode(db, parentId)); if (pn) edges.push(mkEdge(node.id, pn.id, 'PART_OF', false)); }
      for (const cap of getCapabilitiesForAgent(db, refId)) { const cn = push(capabilityNode(cap.id)); edges.push(mkEdge(node.id, cn.id, 'CAPABLE_OF', false)); }
    }
  } else if (refKind === 'artifact' && refId) {
    const art = getArtifact(db, refId);
    if (art) {
      if (art.taskId) { const tn = push(taskNode(db, art.taskId)); if (tn) edges.push(mkEdge(tn.id, node.id, 'PRODUCED', false)); }
      if (art.missionId) { const mn = push(missionNode(db, art.missionId)); if (mn) edges.push(mkEdge(mn.id, node.id, 'PART_OF', false)); }
      if (art.producedByAgentId) { const an = push(agentNode(db, art.producedByAgentId)); if (an) edges.push(mkEdge(an.id, node.id, 'PRODUCED', false)); }
    }
  } else if (refKind === 'knowledge' && refId) {
    const k = getKnowledge(db, refId);
    if (k?.sourceId) { const sn = push(sourceNode(db, k.sourceId)); if (sn) edges.push(mkEdge(node.id, sn.id, 'REFERENCES', false)); }
  } else if (refKind === 'source' && refId) {
    const s = db.brainSources.get(refId);
    if (s?.canonicalRef?.kind === 'artifact') { const an = push(artifactNode(db, s.canonicalRef.id)); if (an) edges.push(mkEdge(node.id, an.id, 'REFERENCES', false)); }
    for (const k of db.brainKnowledge.bySource(refId)) { const kn = push(knowledgeNode(db, k.id)); if (kn) edges.push(mkEdge(kn.id, node.id, 'REFERENCES', false)); }
  }
  return { nodes, edges };
}

function expandNode(db: FounderDb, node: BrainGraphNode): Expansion {
  const projected = projectedExpansion(db, node);
  const persisted = persistedEdgesFor(db, node);
  return { nodes: [...projected.nodes, ...persisted.nodes], edges: [...projected.edges, ...persisted.edges] };
}

/** Resolve the root node from a parsed reference (reads canonical state; never persists). */
function resolveRoot(db: FounderDb, ref: ParsedRef): BrainGraphNode {
  let node: BrainGraphNode | null = null;
  switch (ref.kind) {
    case 'brain_entity': node = brainEntityToNode(db, ref.id); break;
    case 'agent': node = agentNode(db, ref.id); break;
    case 'mission': node = missionNode(db, ref.id); break;
    case 'company_task': node = taskNode(db, ref.id); break;
    case 'artifact': node = artifactNode(db, ref.id); break;
    case 'knowledge': node = knowledgeNode(db, ref.id); break;
    case 'workflow': node = workflowNode(db, ref.id); break;
    case 'source': node = sourceNode(db, ref.id); break;
    case 'skill': { const s = db.skills.all().find((x) => x.id === ref.id); if (s) node = { id: nodeKey('skill', ref.id), kind: 'skill', label: s.name, canonicalRef: { kind: 'skill', id: ref.id }, expandable: false, persisted: false }; break; }
    case 'tool': { const t = db.tools.all().find((x) => x.id === ref.id); if (t) node = { id: nodeKey('tool', ref.id), kind: 'tool', label: t.name, canonicalRef: { kind: 'tool', id: ref.id }, expandable: false, persisted: false }; break; }
    case 'concept': node = brainEntityToNode(db, ref.id); break;
  }
  if (!node) throw new BrainError('entity not found', 404);
  return node;
}

/**
 * Bounded BFS around a root. Deduplicates nodes by key and edges by (from,type,to); enforces
 * MAX_NODES / MAX_EDGES / depth. Read-only. Edges are pruned to the surviving node set.
 */
export function getRadialNeighborhood(db: FounderDb, opts: { entity: string; depth?: number; limit?: number }): RadialGraph {
  const ref = parseEntityRef(opts.entity);
  if (!ref) throw new BrainError('invalid entity reference', 400);
  const depth = clampDepth(opts.depth);
  const maxNodes = clampLimit(opts.limit);

  const nodes = new Map<string, BrainGraphNode>();
  const edges = new Map<string, BrainGraphEdge>();
  let truncated = false;

  const root = resolveRoot(db, ref);
  nodes.set(root.id, root);

  let frontier = [root];
  for (let d = 0; d < depth; d++) {
    const next: BrainGraphNode[] = [];
    for (const node of frontier) {
      const { nodes: ns, edges: es } = expandNode(db, node);
      for (const n of ns) {
        if (nodes.has(n.id)) continue;
        if (nodes.size >= maxNodes) { truncated = true; continue; }
        nodes.set(n.id, n);
        next.push(n);
      }
      for (const e of es) {
        if (edges.has(e.id)) continue;
        if (edges.size >= RADIAL_MAX_EDGES) { truncated = true; continue; }
        edges.set(e.id, e);
      }
    }
    frontier = next;
  }

  // Prune edges whose endpoints did not survive the node cap.
  const survivingEdges = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));
  return { root: root.id, nodes: [...nodes.values()], edges: survivingEdges, truncated };
}
