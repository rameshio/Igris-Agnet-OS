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

describe('operational company brain', () => {
  it('projects the F5 operational graph into KGData from company_events', () => {
    const db = openDb(':memory:');
    const { mission, task, agent } = scenario(db);
    appendEvent(db, { type: 'TASK_ASSIGNED', missionId: mission.id, taskId: task.id, agentId: agent.id, summary: 'assigned' });
    const { graph } = buildOperationalBrainGraph(db, { window: '24h' });
    const ids = new Set(graph.nodes.map((n) => n.id));
    // TASK_ASSIGNED projects a task→agent operational edge (F5); both neurons appear, remapped to KG ids.
    expect(ids.has(`task:${task.id}`)).toBe(true);
    expect(ids.has(`emp:${agent.id}`)).toBe(true);
    // operational neurons carry no artifact content / prompts
    expect(JSON.stringify(graph)).not.toMatch(/ARTIFACT_BODY_LEAK|SECRET_PROMPT/);
  });
});
