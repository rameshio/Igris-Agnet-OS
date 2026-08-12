import { describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';

const now = new Date().toISOString();

/** Seed the legacy `agent_flows` "main" canvas the migration imports. */
function seedMainFlow(db: ReturnType<typeof openDb>): void {
  db.agentFlows.upsert({
    id: 'main',
    name: 'Job Application Pipeline',
    nodes: [
      { id: 'n1', agentId: 'analyzer', x: 10, y: 20 },
      { id: 'n2', agentId: 'reviewer', x: 300, y: 20 },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    createdAt: now,
    updatedAt: now,
  });
}

describe('legacy main-flow migration', () => {
  test('imports the main flow, preserving name, positions, agents, and edges', () => {
    const db = openDb(':memory:');
    seedMainFlow(db);
    const res = db.flowMaintenance.importMainFlow();
    expect(res.imported).toBe(true);

    const wf = db.flowWorkflows.get('wf-main');
    expect(wf?.name).toBe('Job Application Pipeline');
    expect(wf?.draftGraph.nodes).toHaveLength(2);
    expect(wf?.draftGraph.nodes[0]).toMatchObject({ id: 'n1', type: 'agent', x: 10, y: 20, config: { agentId: 'analyzer' } });
    expect(wf?.draftGraph.edges[0]).toMatchObject({ id: 'e1', source: 'n1', target: 'n2' });
    // published as immutable v1
    expect(wf?.currentVersion).toBe(1);
    expect(db.flowVersions.get('wf-main', 1)?.graph.nodes).toHaveLength(2);
  });

  test('is idempotent — re-running does not duplicate the workflow', () => {
    const db = openDb(':memory:');
    seedMainFlow(db);
    db.flowMaintenance.importMainFlow();
    const second = db.flowMaintenance.importMainFlow();
    expect(second.imported).toBe(false);
    expect(db.flowWorkflows.all().filter((w) => w.id === 'wf-main')).toHaveLength(1);
  });

  test('does not delete the original agent_flows source data', () => {
    const db = openDb(':memory:');
    seedMainFlow(db);
    db.flowMaintenance.importMainFlow();
    expect(db.agentFlows.get('main')).not.toBeNull();
    expect(db.agentFlows.get('main')?.name).toBe('Job Application Pipeline');
  });

  test('no-op when there is no legacy main flow', () => {
    const db = openDb(':memory:');
    const res = db.flowMaintenance.importMainFlow();
    expect(res.imported).toBe(false);
    expect(db.flowWorkflows.get('wf-main')).toBeNull();
  });
});

describe('flow_workflows archived_at soft-archive column', () => {
  test('the additive column exists and archive/unarchive toggle active listing', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf-arch', name: 'Arch', graph: { nodes: [], edges: [] } });

    expect(db.flowWorkflows.get('wf-arch')?.archivedAt).toBeNull();
    db.flowWorkflows.archive('wf-arch');
    expect(db.flowWorkflows.get('wf-arch')?.archivedAt).toBeTruthy();
    expect(db.flowWorkflows.all().find((w) => w.id === 'wf-arch')).toBeUndefined();
    expect(db.flowWorkflows.all({ includeArchived: true }).find((w) => w.id === 'wf-arch')).toBeTruthy();

    db.flowWorkflows.unarchive('wf-arch');
    expect(db.flowWorkflows.get('wf-arch')?.archivedAt).toBeNull();
    expect(db.flowWorkflows.all().find((w) => w.id === 'wf-arch')).toBeTruthy();
  });

  test('hasHistory reflects versions and runs', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf-h', name: 'H', graph: { nodes: [], edges: [] } });
    expect(db.flowWorkflows.hasHistory('wf-h')).toBe(false);
    db.flowVersions.create({ id: 'wf-h-v1', workflowId: 'wf-h', version: 1, graph: { nodes: [], edges: [] } });
    expect(db.flowWorkflows.hasHistory('wf-h')).toBe(true);
  });
});
