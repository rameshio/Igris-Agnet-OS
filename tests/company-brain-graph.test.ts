/**
 * Consolidated G-Brain adapter tests (Architecture V2 · consolidation).
 *
 * Proves the ONE brain feeds the original renderers CANONICAL data: the structural
 * graph is a company-wide overview WITHOUT a root (never blank), a deep-link focuses
 * the same graph, ids reverse-map to the Universal Inspector, the operational graph
 * comes from the read-only F5 projection, and nothing leaks or is persisted.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '@/lib/db';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { createCustomAgent } from '@/lib/agents/custom';
import { createMission, createCompanyTask, assignTask } from '@/lib/company/service';
import { createArtifact } from '@/lib/company/manager/artifacts';
import { appendEvent } from '@/lib/company/manager/events';
import { buildStructuralBrainGraph, buildOperationalBrainGraph } from '@/lib/brain/company-brain-graph';
import { inspectTargetForKgId } from '@/lib/brain/kg-ids';

function scenario(db: ReturnType<typeof openDb>) {
  const agent = createCustomAgent(db, { name: 'Scout', departmentId: 'dept-tech', instructions: 'SECRET_PROMPT', model: 'gpt-secret', tools: ['slack'], enabled: true });
  const mission = createMission(db, { title: 'Dinner plan' });
  const task = createCompanyTask(db, mission.id, { title: 'Research restaurants' });
  assignTask(db, task.id, agent.id);
  const artifact = createArtifact(db, { missionId: mission.id, taskId: task.id, producedByAgentId: agent.id, type: 'agent_result', title: 'Options', content: 'ARTIFACT_BODY_LEAK' });
  return { agent, mission, task, artifact };
}

describe('structural company brain', () => {
  it('builds a company-wide overview with NO root (never blank)', () => {
    const db = openDb(':memory:');
    const { mission, task, agent, artifact } = scenario(db);
    const { graph, focusNodeId } = buildStructuralBrainGraph(db);
    expect(focusNodeId).toBeUndefined();
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.has('self')).toBe(true);
    expect(ids.has(`team:${mission.id}`)).toBe(true);
    expect(ids.has(`task:${task.id}`)).toBe(true);
    expect(ids.has(`emp:${agent.id}`)).toBe(true);
    expect(ids.has(`tool:artifact:${artifact.id}`)).toBe(true);
    const kinds = graph.edges.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['pillar', 'sop', 'does', 'uses']));
  });

  it('focuses the same graph on a deep-linked mission', () => {
    const db = openDb(':memory:');
    const { mission } = scenario(db);
    const { focusNodeId } = buildStructuralBrainGraph(db, { focus: { kind: 'mission', id: mission.id } });
    expect(focusNodeId).toBe(`team:${mission.id}`);
  });

  it('includes a focused mission even if it is outside the default set', () => {
    const db = openDb(':memory:');
    // many missions so the default cap could exclude the target
    let target = '';
    for (let i = 0; i < 20; i++) {
      const m = createMission(db, { title: `M${i}` });
      if (i === 0) target = m.id; // oldest → most likely excluded by the recency cap
    }
    const { graph } = buildStructuralBrainGraph(db, { focus: { kind: 'mission', id: target } });
    expect(graph.nodes.some((n) => n.id === `team:${target}`)).toBe(true);
  });

  it('excludes archived missions from the default overview', () => {
    const db = openDb(':memory:');
    const { mission } = scenario(db);
    db.companyMissions.insert({ ...db.companyMissions.get(mission.id)!, status: 'archived' });
    const { graph } = buildStructuralBrainGraph(db);
    expect(graph.nodes.some((n) => n.id === `team:${mission.id}`)).toBe(false);
  });

  it('reverse-maps node ids to canonical Inspector targets', () => {
    expect(inspectTargetForKgId('team:m1')).toEqual({ kind: 'mission', id: 'm1' });
    expect(inspectTargetForKgId('task:t1')).toEqual({ kind: 'task', id: 't1' });
    expect(inspectTargetForKgId('emp:a1')).toEqual({ kind: 'agent', id: 'a1' });
    expect(inspectTargetForKgId('tool:artifact:x')).toEqual({ kind: 'artifact', id: 'x' });
    expect(inspectTargetForKgId('self')).toBeNull();
    expect(inspectTargetForKgId('head:m1')).toBeNull(); // mission-head has no inspect target
  });

  it('never leaks prompts / model ids / artifact content (projection, not persistence)', () => {
    const db = openDb(':memory:');
    scenario(db);
    const before = db.brainEntities.all().length;
    const json = JSON.stringify(buildStructuralBrainGraph(db).graph);
    for (const canary of ['SECRET_PROMPT', 'gpt-secret', 'ARTIFACT_BODY_LEAK']) expect(json).not.toMatch(new RegExp(canary));
    expect(db.brainEntities.all().length).toBe(before); // drawing a node never persists a BrainEntity
  });
});

function publishWorkflow(db: ReturnType<typeof openDb>, id: string) {
  const g: WorkflowGraph = WorkflowGraphSchema.parse({
    nodes: [{ id: 'i', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } }, { id: 'o', type: 'output', x: 0, y: 0, config: { mode: 'display' } }],
    edges: [{ id: 'e', source: 'i', target: 'o' }],
  });
  db.flowWorkflows.create({ id, name: id, graph: g });
  db.flowVersions.create({ id: `${id}-v1`, workflowId: id, version: 1, graph: g });
  db.flowWorkflows.setCurrentVersion(id, 1);
}

/** A full operational scenario: mission → task → agent → workflow_run → approval → artifact + events. */
function operationalScenario(db: ReturnType<typeof openDb>) {
  const { agent, mission, task, artifact } = scenario(db);
  appendEvent(db, { type: 'TASK_CREATED', missionId: mission.id, taskId: task.id, summary: 'created' });
  appendEvent(db, { type: 'TASK_ASSIGNED', missionId: mission.id, taskId: task.id, agentId: agent.id, summary: 'assigned' });
  appendEvent(db, { type: 'ARTIFACT_CREATED', missionId: mission.id, taskId: task.id, artifactId: artifact.id, summary: 'artifact' });
  publishWorkflow(db, 'wf-op');
  const run = db.flowRuns.create({ id: 'run-op', workflowId: 'wf-op', workflowVersion: 1, startingInput: { text: 'STARTING_INPUT_LEAK' } });
  db.flowApprovals.create({ id: 'appr-op', runId: run.id, nodeRunId: null, workflowId: 'wf-op', workflowVersion: 1, nodeId: 'o', title: 'Approve?', message: 'm', context: { secret: 'CONTEXT_LEAK' }, approvalRoute: 'approve', rejectionRoute: 'reject' });
  const t = db.companyTasks.get(task.id)!;
  db.companyTasks.insert({ ...t, executionKind: 'workflow', executionRefId: run.id });
  appendEvent(db, { type: 'WORKFLOW_STARTED', missionId: mission.id, taskId: task.id, workflowId: 'wf-op', summary: 'wf started', metadata: { runId: run.id, version: 1 } });
  appendEvent(db, { type: 'APPROVAL_REQUIRED', missionId: mission.id, taskId: task.id, workflowId: 'wf-op', summary: 'waiting' });
  return { agent, mission, task, artifact, run };
}

describe('operational company brain (F5 → legacy NeuralGraph)', () => {
  it('renders REAL F5 operational neurons (mission/task/agent/run/approval/artifact) — never a legacy self/Notes node', () => {
    const db = openDb(':memory:');
    const { mission, task, agent, artifact, run } = operationalScenario(db);
    const { graph, generatedAt } = buildOperationalBrainGraph(db, { window: '24h' });
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.has(`team:${mission.id}`)).toBe(true);
    expect(ids.has(`task:${task.id}`)).toBe(true);
    expect(ids.has(`emp:${agent.id}`)).toBe(true);
    expect(ids.has(`tool:artifact:${artifact.id}`)).toBe(true);
    expect(ids.has(`tool:run:${run.id}`)).toBe(true);
    expect(ids.has('tool:approval:appr-op')).toBe(true);
    // NO synthetic self/"Notes" node ever
    expect(graph.nodes.some((n) => n.id === 'self' || n.kind === 'self')).toBe(false);
    // real operational edges connect real ids
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(generatedAt).toBeTruthy(); // honest "as of"
  });

  it('an empty window yields an EMPTY graph (no self/Notes fallback)', () => {
    const db = openDb(':memory:');
    scenario(db); // canonical rows exist but NO company_events
    const { graph } = buildOperationalBrainGraph(db, { window: '1h' });
    expect(graph.nodes.length).toBe(0);
  });

  it('includes event nodes that reverse-map to the event Inspector kind', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'Gap' });
    const t = createCompanyTask(db, m.id, { title: 'needs cap', requiredCapabilities: ['ml.train'] });
    appendEvent(db, { type: 'CAPABILITY_GAP', missionId: m.id, taskId: t.id, summary: 'no worker', metadata: { reason: 'capability_gap' } });
    const { graph } = buildOperationalBrainGraph(db, { window: '24h' });
    const eventNode = graph.nodes.find((n) => n.id.startsWith('tool:event:'));
    expect(eventNode).toBeTruthy();
    expect(inspectTargetForKgId(eventNode!.id)?.kind).toBe('event');
  });

  it('never leaks approval context / workflow startingInput / prompts / artifact content', () => {
    const db = openDb(':memory:');
    operationalScenario(db);
    const json = JSON.stringify(buildOperationalBrainGraph(db, { window: '24h' }));
    for (const canary of ['CONTEXT_LEAK', 'STARTING_INPUT_LEAK', 'SECRET_PROMPT', 'ARTIFACT_BODY_LEAK', 'gpt-secret']) {
      expect(json).not.toMatch(new RegExp(canary));
    }
  });

  it('focuses operational activity on a deep-linked mission', () => {
    const db = openDb(':memory:');
    const { mission } = operationalScenario(db);
    const { focusNodeId } = buildOperationalBrainGraph(db, { window: '24h', focus: { kind: 'mission', id: mission.id } });
    expect(focusNodeId).toBe(`team:${mission.id}`);
  });
});
