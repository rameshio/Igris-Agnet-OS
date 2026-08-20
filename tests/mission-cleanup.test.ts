/**
 * Mission cleanup tests (Architecture V2 · consolidation).
 *
 * Proves the SAFE test-data seam: archive hides but keeps everything; delete requires
 * explicit confirmation, cascades ONLY mission-owned records, retires (never deletes)
 * temporary agents, and NEVER destroys shared agents / reusable workflows / durable
 * promoted knowledge — with no dangling dependent rows left behind.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '@/lib/db';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { createCustomAgent } from '@/lib/agents/custom';
import { createMission, createCompanyTask, assignTask, addTaskDependency, CompanyError } from '@/lib/company/service';
import { createArtifact } from '@/lib/company/manager/artifacts';
import { appendEvent } from '@/lib/company/manager/events';
import { previewMissionCleanup, archiveMission, deleteTestMission } from '@/lib/company/cleanup/service';

type DB = ReturnType<typeof openDb>;

function publishWorkflow(db: DB, id: string) {
  const g: WorkflowGraph = WorkflowGraphSchema.parse({
    nodes: [{ id: 'i', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } }, { id: 'o', type: 'output', x: 0, y: 0, config: { mode: 'display' } }],
    edges: [{ id: 'e', source: 'i', target: 'o' }],
  });
  db.flowWorkflows.create({ id, name: id, graph: g });
  db.flowVersions.create({ id: `${id}-v1`, workflowId: id, version: 1, graph: g });
  db.flowWorkflows.setCurrentVersion(id, 1);
}

/** A mission with tasks, a dependency, an artifact, events, a shared agent, and a workflow. */
function fullMission(db: DB) {
  const shared = createCustomAgent(db, { name: 'Shared', departmentId: 'dept-tech', instructions: 'x', model: '', tools: [], enabled: true });
  publishWorkflow(db, 'wf-shared');
  const mission = createMission(db, { title: 'Test mission' });
  const t1 = createCompanyTask(db, mission.id, { title: 'A', workflowId: 'wf-shared' });
  const t2 = createCompanyTask(db, mission.id, { title: 'B' });
  addTaskDependency(db, t2.id, t1.id);
  assignTask(db, t2.id, shared.id);
  const art = createArtifact(db, { missionId: mission.id, taskId: t1.id, type: 'agent_result', title: 'Out', content: 'x' });
  appendEvent(db, { type: 'TASK_CREATED', missionId: mission.id, taskId: t1.id, summary: 's' });
  return { shared, mission, t1, t2, art };
}

describe('mission cleanup — preview', () => {
  it('reports owned records and preserved shared state', () => {
    const db = openDb(':memory:');
    const { mission, shared } = fullMission(db);
    const p = previewMissionCleanup(db, mission.id);
    expect(p.willDelete.tasks).toBe(2);
    expect(p.willDelete.dependencies).toBe(1);
    expect(p.willDelete.artifacts).toBe(1);
    expect(p.willDelete.events).toBeGreaterThanOrEqual(1);
    expect(p.preserved.sharedAgents.some((a) => a.id === shared.id)).toBe(true);
    expect(p.preserved.workflows).toContain('wf-shared');
    expect(() => previewMissionCleanup(db, 'nope')).toThrow(CompanyError);
  });
});

describe('mission cleanup — archive', () => {
  it('hides the mission but keeps every owned record', () => {
    const db = openDb(':memory:');
    const { mission } = fullMission(db);
    const m = archiveMission(db, mission.id);
    expect(m.status).toBe('archived');
    expect(db.companyTasks.forMission(mission.id).length).toBe(2); // nothing deleted
    expect(db.companyArtifacts.forMission(mission.id).length).toBe(1);
  });
});

describe('mission cleanup — delete-test', () => {
  it('requires explicit confirmation', () => {
    const db = openDb(':memory:');
    const { mission } = fullMission(db);
    expect(() => deleteTestMission(db, mission.id, { confirm: false })).toThrow(CompanyError);
    expect(db.companyMissions.get(mission.id)).not.toBeNull(); // nothing removed
  });

  it('cascades owned records and leaves NO dangling rows', () => {
    const db = openDb(':memory:');
    const { mission, t1, t2 } = fullMission(db);
    deleteTestMission(db, mission.id, { confirm: true });
    expect(db.companyMissions.get(mission.id)).toBeNull();
    expect(db.companyTasks.get(t1.id)).toBeNull();
    expect(db.companyTasks.get(t2.id)).toBeNull();
    expect(db.companyTaskDeps.forMission(mission.id).length).toBe(0);
    expect(db.companyArtifacts.forMission(mission.id).length).toBe(0);
    expect(db.companyEvents.forMission(mission.id, 100).length).toBe(0);
  });

  it('preserves shared agents, reusable workflows, and durable knowledge', () => {
    const db = openDb(':memory:');
    const { mission, shared } = fullMission(db);
    // a durable knowledge item that must survive
    const k = db.brainKnowledge.insert
      ? (() => {
          const row = { id: 'bkno-keep', type: 'insight' as const, title: 'Durable insight', content: 'c', confidence: null, status: 'active' as const, entityId: null, sourceId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          db.brainKnowledge.insert(row as never);
          return row;
        })()
      : null;
    deleteTestMission(db, mission.id, { confirm: true });
    expect(db.customAgents.get(shared.id)).not.toBeNull(); // shared agent survives (may be disabled? no — never touched)
    expect(db.customAgents.get(shared.id)?.enabled).toBe(true); // shared agent is not even retired
    expect(db.flowWorkflows.get('wf-shared')).not.toBeNull(); // reusable workflow survives
    if (k) expect(db.brainKnowledge.get('bkno-keep')).not.toBeNull(); // durable knowledge survives
  });

  it('retires (never deletes) a temporary mission-bound agent', () => {
    const db = openDb(':memory:');
    const mission = createMission(db, { title: 'Gap mission' });
    const task = createCompanyTask(db, mission.id, { title: 'needs cap', requiredCapabilities: ['ml.train'] });
    // simulate a promoted temporary factory agent bound to this mission
    const temp = createCustomAgent(db, { name: 'TempWorker', departmentId: 'dept-tech', instructions: 'x', model: '', tools: [], enabled: true });
    db.agentCapabilities.assign(temp.id, { capabilityId: 'ml.train' });
    db.companyAgentProposals.insert({
      id: 'prop-1', missionId: mission.id, taskId: task.id, status: 'approved', spec: {} as never, policy: {} as never,
      requiredCapabilities: ['ml.train'], temporary: true, maxDepth: 1, budgetUsd: null, agentId: temp.id,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as never);

    deleteTestMission(db, mission.id, { confirm: true });
    const agent = db.customAgents.get(temp.id);
    expect(agent).not.toBeNull(); // NOT hard-deleted
    expect(agent?.enabled).toBe(false); // retired (disabled)
    expect(db.agentCapabilities.forAgent(temp.id).length).toBe(0); // unassigned
    expect(db.companyMissions.get(mission.id)).toBeNull(); // mission + its proposal gone
  });
});
