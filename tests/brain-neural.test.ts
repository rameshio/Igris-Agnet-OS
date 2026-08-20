/**
 * G-Brain Neural projection tests (Architecture V2 · F5).
 *
 * Proves Neural projects the operational graph from the `company_events` ledger, reconciles
 * node STATUS from CURRENT canonical state (never stale event replay), stays bounded/focused/
 * deduped, exposes safe fields only, and NEVER mutates any table.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '@/lib/db';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { createCustomAgent } from '@/lib/agents/custom';
import { createMission, createCompanyTask, assignTask, updateCompanyTask } from '@/lib/company/service';
import { createArtifact } from '@/lib/company/manager/artifacts';
import { appendEvent } from '@/lib/company/manager/events';
import { getNeuralGraph } from '@/lib/brain/neural/service';

type DB = ReturnType<typeof openDb>;
const G = (n: unknown[], e: unknown[]): WorkflowGraph => WorkflowGraphSchema.parse({ nodes: n, edges: e });

function publishWorkflow(db: DB, id: string) {
  const g = G([
    { id: 'i', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
    { id: 'o', type: 'output', x: 0, y: 0, config: { mode: 'display' } },
  ], [{ id: 'e', source: 'i', target: 'o' }]);
  db.flowWorkflows.create({ id, name: id, graph: g });
  db.flowVersions.create({ id: `${id}-v1`, workflowId: id, version: 1, graph: g });
  db.flowWorkflows.setCurrentVersion(id, 1);
}

function baseScenario(db: DB) {
  const agent = createCustomAgent(db, { name: 'Scout', departmentId: 'dept-tech', instructions: 'x', model: '', tools: [], enabled: true });
  const mission = createMission(db, { title: 'Market study' });
  const task = createCompanyTask(db, mission.id, { title: 'Analyze' });
  assignTask(db, task.id, agent.id);
  const artifact = createArtifact(db, { missionId: mission.id, taskId: task.id, producedByAgentId: agent.id, type: 'agent_result', title: 'Findings', content: 'body' });
  appendEvent(db, { type: 'TASK_CREATED', missionId: mission.id, taskId: task.id, summary: 'Task created' });
  appendEvent(db, { type: 'TASK_ASSIGNED', missionId: mission.id, taskId: task.id, agentId: agent.id, summary: 'Assigned' });
  appendEvent(db, { type: 'ARTIFACT_CREATED', missionId: mission.id, taskId: task.id, artifactId: artifact.id, summary: 'Artifact' });
  return { agent, mission, task, artifact };
}

describe('getNeuralGraph — operational projection', () => {
  it('projects mission→task, task→agent, task→artifact', () => {
    const db = openDb(':memory:');
    const { mission, task, agent, artifact } = baseScenario(db);
    const g = getNeuralGraph(db, { entity: `mission:${mission.id}` });
    const types = g.edges.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['has_task', 'assigned_to', 'produced']));
    expect(g.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([`mission:${mission.id}`, `company_task:${task.id}`, `agent:${agent.id}`, `artifact:${artifact.id}`]));
  });

  it('projects task→workflow_run and reconciles run status', () => {
    const db = openDb(':memory:');
    const { mission, task } = baseScenario(db);
    publishWorkflow(db, 'wf-1');
    const run = db.flowRuns.create({ id: 'run-1', workflowId: 'wf-1', workflowVersion: 1, startingInput: { text: 'SECRET STARTING INPUT' } });
    appendEvent(db, { type: 'WORKFLOW_STARTED', missionId: mission.id, taskId: task.id, workflowId: 'wf-1', summary: 'wf started', metadata: { runId: run.id, version: 1 } });
    const g = getNeuralGraph(db, { entity: `mission:${mission.id}` });
    const wfRun = g.nodes.find((n) => n.kind === 'workflow_run');
    expect(wfRun?.id).toBe('workflow_run:run-1');
    expect(g.edges.some((e) => e.type === 'ran_workflow')).toBe(true);
    // privacy: startingInput must never leak
    expect(JSON.stringify(g)).not.toMatch(/SECRET STARTING INPUT/);
  });

  it('projects an approval-required edge and never leaks context_json', () => {
    const db = openDb(':memory:');
    const { mission, task } = baseScenario(db);
    publishWorkflow(db, 'wf-1');
    const run = db.flowRuns.create({ id: 'run-appr', workflowId: 'wf-1', workflowVersion: 1, startingInput: { text: 'in' } });
    db.flowApprovals.create({ id: 'appr-1', runId: run.id, nodeRunId: null, workflowId: 'wf-1', workflowVersion: 1, nodeId: 'o', title: 'Approve?', message: 'msg', context: { secret: 'SECRET CONTEXT BLOB' }, approvalRoute: 'approve', rejectionRoute: 'reject' });
    updateCompanyTask(db, task.id, { status: 'running' });
    updateCompanyTask(db, task.id, { status: 'waiting_approval' });
    // point the task at the run so the approval resolves
    const t = db.companyTasks.get(task.id)!;
    db.companyTasks.insert({ ...t, executionKind: 'workflow', executionRefId: run.id });
    appendEvent(db, { type: 'APPROVAL_REQUIRED', missionId: mission.id, taskId: task.id, workflowId: 'wf-1', summary: 'waiting approval' });
    const g = getNeuralGraph(db, { entity: `mission:${mission.id}` });
    const appr = g.nodes.find((n) => n.kind === 'approval');
    expect(appr?.id).toBe('approval:appr-1');
    expect(appr?.status).toBe('waiting_approval');
    expect(g.edges.some((e) => e.type === 'requested_approval')).toBe(true);
    expect(JSON.stringify(g)).not.toMatch(/SECRET CONTEXT BLOB/);
  });

  it('CURRENT canonical status overrides a stale event', () => {
    const db = openDb(':memory:');
    const { mission, task } = baseScenario(db); // last event was TASK_ASSIGNED
    updateCompanyTask(db, task.id, { status: 'running' });
    updateCompanyTask(db, task.id, { status: 'completed' });
    const g = getNeuralGraph(db, { entity: `mission:${mission.id}` });
    const taskNode = g.nodes.find((n) => n.id === `company_task:${task.id}`)!;
    expect(taskNode.status).toBe('completed'); // not "assigned/queued" from the stale event
    expect(taskNode.active).toBe(false);
  });

  it('shows factory lifecycle events as event nodes when they exist', () => {
    const db = openDb(':memory:');
    const { mission, task } = baseScenario(db);
    appendEvent(db, { type: 'CAPABILITY_GAP', missionId: mission.id, taskId: task.id, summary: 'Capability gap' });
    const g = getNeuralGraph(db, { entity: `mission:${mission.id}` });
    expect(g.nodes.some((n) => n.kind === 'event')).toBe(true);
    expect(g.edges.some((e) => e.type === 'handoff')).toBe(true);
  });
});

describe('getNeuralGraph — bounds, focus, dedup, safety', () => {
  it('enforces the event limit and reports truncation', () => {
    const db = openDb(':memory:');
    const { mission } = baseScenario(db); // 3 events
    const g = getNeuralGraph(db, { entity: `mission:${mission.id}`, limit: 1 });
    expect(g.truncated).toBe(true);
  });

  it('focuses by mission and returns a company-now view when no root', () => {
    const db = openDb(':memory:');
    baseScenario(db);
    const now = getNeuralGraph(db, {});
    expect(now.root).toBeUndefined();
    expect(now.nodes.length).toBeGreaterThan(0);
    expect(now.window.from < now.window.to).toBe(true);
  });

  it('rejects a malformed root reference', () => {
    const db = openDb(':memory:');
    expect(() => getNeuralGraph(db, { entity: 'DROP TABLE' })).toThrow();
  });

  it('deduplicates repeated events into single nodes/edges', () => {
    const db = openDb(':memory:');
    const { mission, task, agent } = baseScenario(db);
    appendEvent(db, { type: 'TASK_ASSIGNED', missionId: mission.id, taskId: task.id, agentId: agent.id, summary: 'dup' });
    const g = getNeuralGraph(db, { entity: `mission:${mission.id}` });
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(g.nodes.length);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
  });

  it('NEVER mutates: company_events + brain tables unchanged after projecting', () => {
    const db = openDb(':memory:');
    const { mission } = baseScenario(db);
    const beforeEv = db.companyEvents.recent(500).length;
    const beforeEnt = db.brainEntities.all().length;
    const beforeKnow = db.brainKnowledge.all().length;
    getNeuralGraph(db, { entity: `mission:${mission.id}`, window: '24h' });
    getNeuralGraph(db, {});
    expect(db.companyEvents.recent(500).length).toBe(beforeEv);
    expect(db.brainEntities.all().length).toBe(beforeEnt);
    expect(db.brainKnowledge.all().length).toBe(beforeKnow);
  });
});
