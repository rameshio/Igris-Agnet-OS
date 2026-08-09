import { describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import type { WorkflowGraph } from '@/lib/flows/schema';

const sampleGraph: WorkflowGraph = {
  nodes: [
    { id: 'n1', type: 'agent', x: 10, y: 20, config: { agentId: 'a1' } },
    { id: 'n2', type: 'output', x: 200, y: 20, config: { mode: 'display' } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2', mapping: { mode: 'all' } }],
};

describe('flow workflow + version repos', () => {
  test('create → save draft → reload round-trips the graph', () => {
    const db = openDb(':memory:');
    const wf = db.flowWorkflows.create({ id: 'wf-x', name: 'My Flow', description: 'd', graph: { nodes: [], edges: [] } });
    expect(wf.name).toBe('My Flow');
    expect(wf.draftGraph.nodes).toHaveLength(0);

    db.flowWorkflows.saveDraft('wf-x', sampleGraph);
    const reloaded = db.flowWorkflows.get('wf-x');
    expect(reloaded?.draftGraph.nodes).toHaveLength(2);
    expect(reloaded?.draftGraph.nodes[0]).toMatchObject({ id: 'n1', type: 'agent', x: 10, y: 20 });
    expect(reloaded?.draftGraph.edges[0]).toMatchObject({ id: 'e1', source: 'n1', target: 'n2' });
  });

  test('publishing an immutable version freezes the graph and sets the pointer', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf-y', name: 'Y', graph: sampleGraph });
    const v = db.flowVersions.nextVersion('wf-y');
    expect(v).toBe(1);
    db.flowVersions.create({ id: 'wf-y-v1', workflowId: 'wf-y', version: v, graph: sampleGraph });
    db.flowWorkflows.setCurrentVersion('wf-y', v);

    expect(db.flowWorkflows.get('wf-y')?.currentVersion).toBe(1);
    const versions = db.flowVersions.forWorkflow('wf-y');
    expect(versions).toHaveLength(1);
    const snap = db.flowVersions.get('wf-y', 1);
    expect(snap?.graph.nodes).toHaveLength(2);
    expect(db.flowVersions.nextVersion('wf-y')).toBe(2);
  });

  test('remove deletes the workflow and its versions', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf-z', name: 'Z', graph: sampleGraph });
    db.flowVersions.create({ id: 'wf-z-v1', workflowId: 'wf-z', version: 1, graph: sampleGraph });
    db.flowWorkflows.remove('wf-z');
    expect(db.flowWorkflows.get('wf-z')).toBeNull();
    expect(db.flowVersions.forWorkflow('wf-z')).toHaveLength(0);
  });
});
