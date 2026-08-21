/**
 * G-Brain Radial projection tests (Architecture V2 · F4).
 *
 * Proves the projection combines PROJECTED canonical edges with PERSISTED G-Brain edges,
 * dedupes, enforces bounds, is strictly deep-link-parsed, exposes safe fields only, and —
 * load-bearing — NEVER persists anything (viewing a canonical object creates no BrainEntity).
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '@/lib/db';
import { createCustomAgent } from '@/lib/agents/custom';
import { createMission, createCompanyTask, addTaskDependency, assignTask } from '@/lib/company/service';
import { createArtifact } from '@/lib/company/manager/artifacts';
import { promoteArtifactToBrain } from '@/lib/brain/core/promote';
import { getRadialNeighborhood } from '@/lib/brain/projection/radial';
import { parseEntityRef, RADIAL_MAX_DEPTH } from '@/lib/brain/projection/model';

type DB = ReturnType<typeof openDb>;

function scenario(db: DB) {
  const agent = createCustomAgent(db, { name: 'Scout', departmentId: 'dept-tech', instructions: 'x', model: '', tools: [], enabled: true });
  db.capabilities.upsert({ id: 'research.market', name: 'research.market' });
  db.agentCapabilities.assign(agent.id, { capabilityId: 'research.market' });
  const mission = createMission(db, { title: 'Market study' });
  const dep = createCompanyTask(db, mission.id, { title: 'Prep' });
  const task = createCompanyTask(db, mission.id, { title: 'Analyze', requiredCapabilities: ['research.market'] });
  addTaskDependency(db, task.id, dep.id);
  assignTask(db, task.id, agent.id);
  const artifact = createArtifact(db, { missionId: mission.id, taskId: task.id, producedByAgentId: agent.id, type: 'agent_result', title: 'Findings', summary: 's', content: 'body' });
  return { agent, mission, dep, task, artifact };
}

describe('parseEntityRef', () => {
  it('accepts brain ids and kind:id refs (task alias → company_task)', () => {
    expect(parseEntityRef('bent-abc')).toEqual({ kind: 'brain_entity', id: 'bent-abc' });
    expect(parseEntityRef('bkno-abc')).toEqual({ kind: 'knowledge', id: 'bkno-abc' });
    expect(parseEntityRef('mission:mission-1')).toEqual({ kind: 'mission', id: 'mission-1' });
    expect(parseEntityRef('task:ctask-1')).toEqual({ kind: 'company_task', id: 'ctask-1' });
  });
  it('rejects malformed / unknown refs (no arbitrary query)', () => {
    expect(parseEntityRef('')).toBeNull();
    expect(parseEntityRef('DROP TABLE')).toBeNull();
    expect(parseEntityRef('galaxy:1')).toBeNull();
    expect(parseEntityRef("mission:1' OR '1'='1")).toBeNull();
  });
});

describe('getRadialNeighborhood — projected edges', () => {
  it('mission root projects HAS_TASK edges to its tasks (not persisted)', () => {
    const db = openDb(':memory:');
    const { mission, task, dep } = scenario(db);
    const g = getRadialNeighborhood(db, { entity: `mission:${mission.id}` });
    const hasTask = g.edges.filter((e) => e.type === 'HAS_TASK');
    expect(hasTask.length).toBe(2); // Analyze + Prep
    expect(hasTask.every((e) => e.persisted === false)).toBe(true);
    expect(g.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([`company_task:${task.id}`, `company_task:${dep.id}`]));
  });

  it('task root projects ASSIGNED_TO, PRODUCED, DEPENDS_ON, REQUIRES', () => {
    const db = openDb(':memory:');
    const { task, agent, artifact, dep } = scenario(db);
    const g = getRadialNeighborhood(db, { entity: `task:${task.id}` });
    const types = g.edges.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['ASSIGNED_TO', 'PRODUCED', 'DEPENDS_ON', 'REQUIRES', 'HAS_TASK']));
    expect(g.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([`agent:${agent.id}`, `artifact:${artifact.id}`, `company_task:${dep.id}`, 'capability:research.market']));
  });

  it('agent node exposes SAFE fields only (no model / no system prompt)', () => {
    const db = openDb(':memory:');
    const { agent, task } = scenario(db);
    const g = getRadialNeighborhood(db, { entity: `agent:${agent.id}`, depth: 1 });
    const node = g.nodes.find((n) => n.id === `agent:${agent.id}`)!;
    expect(node.label).toBe('Scout');
    expect(JSON.stringify(g)).not.toMatch(/system prompt|instructions|"model"/i);
    // capability projected
    expect(g.edges.some((e) => e.type === 'CAPABLE_OF')).toBe(true);
    expect(task).toBeDefined();
  });
});

describe('getRadialNeighborhood — persisted edges', () => {
  it('a promoted artifact shows the PERSISTED Knowledge DERIVED_FROM edge', () => {
    const db = openDb(':memory:');
    const { artifact } = scenario(db);
    promoteArtifactToBrain(db, artifact.id); // creates persisted brain entities + DERIVED_FROM
    const g = getRadialNeighborhood(db, { entity: `artifact:${artifact.id}` });
    const derived = g.edges.find((e) => e.type === 'DERIVED_FROM');
    expect(derived).toBeDefined();
    expect(derived!.persisted).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'knowledge' && n.persisted === true)).toBe(true);
  });
});

describe('getRadialNeighborhood — bounds, dedup, no persistence', () => {
  it('deduplicates nodes and edges', () => {
    const db = openDb(':memory:');
    const { task } = scenario(db);
    const g = getRadialNeighborhood(db, { entity: `task:${task.id}`, depth: RADIAL_MAX_DEPTH });
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(g.nodes.length);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
  });

  it('enforces the node limit and reports truncation', () => {
    const db = openDb(':memory:');
    const { mission } = scenario(db);
    const g = getRadialNeighborhood(db, { entity: `mission:${mission.id}`, limit: 1 });
    expect(g.nodes.length).toBe(1); // only the root fits
    expect(g.truncated).toBe(true);
  });

  it('clamps depth to the max', () => {
    const db = openDb(':memory:');
    const { mission } = scenario(db);
    // depth 99 must not throw / must behave as <= MAX_DEPTH
    const g = getRadialNeighborhood(db, { entity: `mission:${mission.id}`, depth: 99 });
    expect(g.nodes.length).toBeGreaterThan(0);
  });

  it('NEVER persists: projecting a canonical mission creates no BrainEntity/Relationship', () => {
    const db = openDb(':memory:');
    const { mission } = scenario(db);
    const beforeE = db.brainEntities.all().length;
    const beforeR = db.brainRelationships.all().length;
    getRadialNeighborhood(db, { entity: `mission:${mission.id}`, depth: RADIAL_MAX_DEPTH });
    expect(db.brainEntities.all().length).toBe(beforeE);
    expect(db.brainRelationships.all().length).toBe(beforeR);
  });

  it('rejects an invalid entity reference (400)', () => {
    const db = openDb(':memory:');
    expect(() => getRadialNeighborhood(db, { entity: 'not-a-ref' })).toThrow();
  });
});
