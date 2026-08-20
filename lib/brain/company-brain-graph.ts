/**
 * Company Brain graph adapter (Architecture V2 · G-Brain consolidation).
 *
 * ONE G-Brain: the ORIGINAL attractive radial/neural renderers (KnowledgeGraph /
 * NeuralGraph, which both consume the legacy `KGData` ring model) are now fed
 * CANONICAL company data instead of org seed data. This module is the adapter —
 * it projects the canonical systems into `KGData`:
 *   • STRUCTURAL  (Radial)  — company → missions → tasks → agents → artifacts/knowledge/workflows
 *   • OPERATIONAL (Neural)  — the F5 live/recent operational projection, remapped to `KGData`
 *
 * This is a PROJECTION, exactly like F4/F5: a visualization node is NOT a persisted
 * BrainEntity and a visualization edge is NOT a persisted BrainRelationship. Nothing
 * here writes to any table, and no Mission/Task/Agent is ingested into durable
 * G-Brain knowledge by being drawn. Node ids encode the canonical ref so a click can
 * open the ONE Universal Inspector (`inspectTargetForKgId`).
 */
import type { FounderDb } from '@/lib/db';
import type { KGNode, KGEdge, KnowledgeGraph as KGData } from '@/lib/knowledge-graph';
import { listMissions, listTasksForMission } from '@/lib/company/service';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { getNeuralGraph } from '@/lib/brain/neural/service';
import type { MissionStatus } from '@/lib/company/model';
import { KG_SELF as SELF, kgId as idFns, inspectTargetForKgId } from '@/lib/brain/kg-ids';

export { inspectTargetForKgId };

// ── Bounds (never "load the whole company") ───────────────────────────────────
export const BRAIN_MAX_MISSIONS = 12;
export const BRAIN_MAX_TASKS_PER_MISSION = 14;
export const BRAIN_MAX_ARTIFACTS_PER_MISSION = 8;
export const BRAIN_MAX_KNOWLEDGE = 24;
export const BRAIN_MAX_NODES = 200;

export type CompanyBrainGraph = {
  graph: KGData;
  focusNodeId?: string;
  /** Operational only — the F5 projection's honest "as of" time + whether a bound was hit. */
  generatedAt?: string;
  truncated?: boolean;
};

// Legacy ring per KG kind (mirrors lib/knowledge-graph RING; the renderer lays out by it).
const RING = { self: 0, team: 1, head: 2, task: 2, employee: 3, person: 3, tool: 4 } as const;

/** Deterministic mission priority for the bounded overview: live work first, recent next. */
const MISSION_RANK: Record<MissionStatus, number> = { blocked: 0, active: 1, draft: 2, completed: 3, failed: 4, cancelled: 5, archived: 6 };

/**
 * STRUCTURAL company brain → `KGData`. A bounded, deterministic company-wide overview
 * by default; when `focus` names a canonical entity, its subtree is guaranteed present
 * and the focused KG node id is returned so the renderer centers on it.
 */
export function buildStructuralBrainGraph(db: FounderDb, opts: { focus?: { kind: string; id: string } | null } = {}): CompanyBrainGraph {
  const nodes: KGNode[] = [];
  const edges: KGEdge[] = [];
  const nodeIds = new Set<string>();
  const add = (n: KGNode) => {
    if (nodeIds.has(n.id) || nodes.length >= BRAIN_MAX_NODES) return;
    nodeIds.add(n.id);
    nodes.push(n);
  };
  const link = (source: string, target: string, kind: KGEdge['kind']) => {
    if (nodeIds.has(source) && nodeIds.has(target)) edges.push({ source, target, kind });
  };

  add({ id: SELF, kind: 'self', label: 'IGRIS', ring: RING.self });

  const agentById = new Map(allRuntimeAgents(db).map((a) => [a.id, a]));
  const agentLabel = (id: string) => agentById.get(id)?.name ?? id;

  // Pick the bounded set of missions to show: live-first, then most recent, always
  // including the focused mission (or the focused task/artifact's mission).
  const all = listMissions(db).filter((m) => m.status !== 'archived' && m.status !== 'cancelled');
  const ranked = [...all].sort(
    (a, b) => MISSION_RANK[a.status] - MISSION_RANK[b.status] || (a.updatedAt < b.updatedAt ? 1 : -1),
  );
  const chosen = ranked.slice(0, BRAIN_MAX_MISSIONS);
  const chosenIds = new Set(chosen.map((m) => m.id));

  let focusMissionId: string | undefined;
  if (opts.focus) {
    if (opts.focus.kind === 'mission') focusMissionId = opts.focus.id;
    else if (opts.focus.kind === 'task' || opts.focus.kind === 'company_task') focusMissionId = db.companyTasks.get(opts.focus.id)?.missionId;
    else if (opts.focus.kind === 'artifact') focusMissionId = db.companyArtifacts.get(opts.focus.id)?.missionId;
  }
  if (focusMissionId && !chosenIds.has(focusMissionId)) {
    const fm = db.companyMissions.get(focusMissionId);
    if (fm) {
      chosen.unshift(fm);
      chosenIds.add(fm.id);
    }
  }

  for (const mission of chosen) {
    const teamId = idFns.mission(mission.id);
    add({ id: teamId, kind: 'team', label: mission.title, ring: RING.team });
    link(SELF, teamId, 'pillar');
    add({ id: idFns.missionHead(mission.id), kind: 'head', label: mission.status, ring: RING.head });
    link(teamId, idFns.missionHead(mission.id), 'member');

    const tasks = listTasksForMission(db, mission.id).slice(0, BRAIN_MAX_TASKS_PER_MISSION);
    for (const task of tasks) {
      const taskId = idFns.task(task.id);
      add({ id: taskId, kind: 'task', label: task.title, ring: RING.task });
      link(teamId, taskId, 'sop');
      if (task.assignedAgentId) {
        const empId = idFns.agent(task.assignedAgentId);
        add({ id: empId, kind: 'employee', label: agentLabel(task.assignedAgentId), ring: RING.employee });
        link(taskId, empId, 'does');
      }
      if (task.workflowId) {
        const wfId = idFns.workflow(task.workflowId);
        add({ id: wfId, kind: 'tool', label: db.flowWorkflows.get(task.workflowId)?.name ?? 'workflow', ring: RING.tool });
        link(taskId, wfId, 'uses');
      }
    }

    for (const art of db.companyArtifacts.forMission(mission.id).slice(0, BRAIN_MAX_ARTIFACTS_PER_MISSION)) {
      const toolId = idFns.artifact(art.id);
      add({ id: toolId, kind: 'tool', label: art.title, ring: RING.tool });
      const producer = art.producedByAgentId ? idFns.agent(art.producedByAgentId) : art.taskId ? idFns.task(art.taskId) : teamId;
      link(nodeIds.has(producer) ? producer : teamId, toolId, 'uses');
    }
  }

  // Promoted durable knowledge (bounded) — hangs off the company core.
  for (const k of db.brainKnowledge.all().filter((x) => x.status !== 'archived').slice(0, BRAIN_MAX_KNOWLEDGE)) {
    const toolId = idFns.knowledge(k.id);
    add({ id: toolId, kind: 'tool', label: k.title, ring: RING.tool });
    link(SELF, toolId, 'uses');
  }

  const focusNodeId = opts.focus ? kgIdForFocus(opts.focus, nodeIds) : undefined;
  return { graph: { nodes, edges }, focusNodeId };
}

/** Map a focus ref → its KG node id, if present in the graph. */
function kgIdForFocus(focus: { kind: string; id: string }, present: Set<string>): string | undefined {
  const candidates: string[] = [];
  if (focus.kind === 'mission') candidates.push(idFns.mission(focus.id));
  else if (focus.kind === 'task' || focus.kind === 'company_task') candidates.push(idFns.task(focus.id));
  else if (focus.kind === 'agent') candidates.push(idFns.agent(focus.id));
  else if (focus.kind === 'artifact') candidates.push(idFns.artifact(focus.id));
  else if (focus.kind === 'knowledge') candidates.push(idFns.knowledge(focus.id));
  else if (focus.kind === 'workflow') candidates.push(idFns.workflow(focus.id));
  return candidates.find((c) => present.has(c));
}

// ── Operational (Neural) — remap the F5 projection into KGData ────────────────
const NEURAL_KIND_TO_KG: Record<string, KGNode['kind']> = {
  mission: 'team',
  task: 'task',
  agent: 'employee',
  workflow: 'tool',
  workflow_run: 'tool',
  approval: 'tool',
  artifact: 'tool',
  event: 'tool',
};

/** OPERATIONAL company brain → `KGData`, from the read-only F5 projection over `company_events`. */
export function buildOperationalBrainGraph(db: FounderDb, opts: { window?: string; focus?: { kind: string; id: string } | null } = {}): CompanyBrainGraph {
  const entity = opts.focus ? `${opts.focus.kind === 'company_task' ? 'task' : opts.focus.kind}:${opts.focus.id}` : undefined;
  const neural = getNeuralGraph(db, { entity, window: opts.window });

  // NO synthetic `self`/"Notes" node — the operational graph is ONLY real F5 neurons
  // (mission/task/agent/workflow/run/approval/artifact/event). An empty window yields an
  // empty graph, and the controller shows an honest "no recent activity" state (never Notes).
  const nodes: KGNode[] = [];
  const nodeIds = new Set<string>();
  const edges: KGEdge[] = [];

  // F5 node id is `<neuralKind>:<canonicalId>`; re-key to the KG id conventions.
  const kgIdOf = (neuralId: string): string | null => {
    const i = neuralId.indexOf(':');
    if (i < 0) return null;
    const kind = neuralId.slice(0, i);
    const id = neuralId.slice(i + 1);
    switch (kind) {
      case 'mission': return idFns.mission(id);
      case 'company_task': return idFns.task(id);
      case 'agent': return idFns.agent(id);
      case 'workflow': return idFns.workflow(id);
      case 'workflow_run': return idFns.run(id);
      case 'approval': return idFns.approval(id);
      case 'artifact': return idFns.artifact(id);
      case 'event': return idFns.event(id); // operational status/control markers
      default: return null;
    }
  };

  for (const n of neural.nodes) {
    const kgKind = NEURAL_KIND_TO_KG[n.kind];
    const kgId = kgIdOf(n.id);
    if (!kgKind || !kgId || nodeIds.has(kgId)) continue;
    nodes.push({ id: kgId, kind: kgKind, label: n.label, ring: RING[kgKind] });
    nodeIds.add(kgId);
  }
  // Only REAL F5 operational edges — no decorative/fake edges.
  for (const e of neural.edges) {
    const s = kgIdOf(e.from);
    const t = kgIdOf(e.to);
    if (s && t && nodeIds.has(s) && nodeIds.has(t)) edges.push({ source: s, target: t, kind: 'does' });
  }

  const focusNodeId = opts.focus ? kgIdForFocus(opts.focus, nodeIds) : undefined;
  return { graph: { nodes, edges }, focusNodeId, generatedAt: neural.generatedAt, truncated: neural.truncated };
}
