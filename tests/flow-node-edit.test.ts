/**
 * Node editing + draft-deletion round-trip (UX bug fixes: "Input node cannot be
 * edited", "cannot delete flow nodes").
 *
 * Editing happens on the DRAFT; publishing snapshots an immutable version. These
 * tests prove: (1) an Input node's editable metadata (label, description, value,
 * format) survives save + reload; (2) deleting a node from the draft persists and
 * cleans its edges; (3) an already-published version is NOT mutated by later draft
 * edits — only a new Publish changes what runs.
 */
import { describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { removeNodeFromGraph } from '@/lib/flows/graph-ops';

const base: WorkflowGraph = WorkflowGraphSchema.parse({
  nodes: [
    { id: 'in', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
    { id: 'ag', type: 'agent', x: 100, y: 0, config: { agentId: 'a1' } },
    { id: 'out', type: 'output', x: 200, y: 0, config: { mode: 'display' } },
  ],
  edges: [
    { id: 'e-in-ag', source: 'in', target: 'ag' },
    { id: 'e-ag-out', source: 'ag', target: 'out' },
  ],
});

describe('Input node editing round-trip', () => {
  test('edited label/description/value/format persist through save + reload', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf', name: 'W', graph: base });

    const edited = WorkflowGraphSchema.parse({
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === 'in'
          ? { ...n, label: 'Lead source', description: 'Where the lead came from', config: { value: 'fallback text', format: 'json' } }
          : n,
      ),
    });
    db.flowWorkflows.saveDraft('wf', edited);

    const inNode = db.flowWorkflows.get('wf')?.draftGraph.nodes.find((n) => n.id === 'in');
    expect(inNode).toMatchObject({
      label: 'Lead source',
      description: 'Where the lead came from',
      config: { value: 'fallback text', format: 'json' },
    });
  });
});

describe('Node deletion round-trip', () => {
  test('saving a draft with a node removed persists the deletion + edge cleanup', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf2', name: 'W2', graph: base });

    const pruned = WorkflowGraphSchema.parse(removeNodeFromGraph(base, 'ag'));
    db.flowWorkflows.saveDraft('wf2', pruned);

    const reloaded = db.flowWorkflows.get('wf2')?.draftGraph;
    expect(reloaded?.nodes.map((n) => n.id)).toEqual(['in', 'out']);
    expect(reloaded?.edges).toHaveLength(0); // both edges touched 'ag'
  });

  test('deleting a node in the draft does NOT change an already-published version', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf3', name: 'W3', graph: base });
    // Publish v1 with all three nodes.
    db.flowVersions.create({ id: 'wf3-v1', workflowId: 'wf3', version: 1, graph: base });
    db.flowWorkflows.setCurrentVersion('wf3', 1);

    // Now delete a node from the draft and save.
    db.flowWorkflows.saveDraft('wf3', WorkflowGraphSchema.parse(removeNodeFromGraph(base, 'ag')));

    // Draft reflects the deletion; the immutable v1 is untouched.
    expect(db.flowWorkflows.get('wf3')?.draftGraph.nodes).toHaveLength(2);
    expect(db.flowVersions.get('wf3', 1)?.graph.nodes).toHaveLength(3);
    expect(db.flowVersions.get('wf3', 1)?.graph.nodes.find((n) => n.id === 'ag')).toBeTruthy();
  });
});
