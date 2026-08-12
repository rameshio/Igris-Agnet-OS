/**
 * Node-deletion graph math + the keyboard-delete guard (UX bug fix).
 *
 * These are pure (no React/DOM), so the canvas's delete behavior is unit-tested
 * here: removing a node drops the node AND every connected edge (no dangling
 * edges), unrelated nodes survive, and Delete/Backspace only fires when the user
 * is NOT typing in a text field.
 */
import { describe, expect, test } from 'vitest';
import { removeNodeFromGraph, connectedEdgeIds, shouldDeleteSelection } from '@/lib/flows/graph-ops';
import type { WorkflowGraph } from '@/lib/flows/schema';

// Input → Agent → Output (the manual-test shape), plus an unrelated node.
const graph: WorkflowGraph = {
  nodes: [
    { id: 'in', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
    { id: 'ag', type: 'agent', x: 100, y: 0, config: { agentId: 'a1' } },
    { id: 'out', type: 'output', x: 200, y: 0, config: { mode: 'display' } },
    { id: 'other', type: 'output', x: 200, y: 100, config: { mode: 'display' } },
  ],
  edges: [
    { id: 'e-in-ag', source: 'in', target: 'ag', mapping: { mode: 'all' } },
    { id: 'e-ag-out', source: 'ag', target: 'out', mapping: { mode: 'all' } },
  ],
};

describe('removeNodeFromGraph', () => {
  test('deleting a node removes that node', () => {
    const next = removeNodeFromGraph(graph, 'ag');
    expect(next.nodes.map((n) => n.id)).toEqual(['in', 'out', 'other']);
  });

  test('removes the connected incoming edge', () => {
    const next = removeNodeFromGraph(graph, 'ag');
    expect(next.edges.find((e) => e.id === 'e-in-ag')).toBeUndefined();
  });

  test('removes the connected outgoing edge', () => {
    const next = removeNodeFromGraph(graph, 'ag');
    expect(next.edges.find((e) => e.id === 'e-ag-out')).toBeUndefined();
  });

  test('deleting the middle node leaves NO dangling edges', () => {
    const next = removeNodeFromGraph(graph, 'ag');
    const ids = new Set(next.nodes.map((n) => n.id));
    for (const e of next.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
    expect(next.edges).toHaveLength(0);
  });

  test('an unrelated node and its type survive', () => {
    const next = removeNodeFromGraph(graph, 'ag');
    expect(next.nodes.find((n) => n.id === 'other')).toMatchObject({ id: 'other', type: 'output' });
  });

  test('is immutable — the input graph is untouched', () => {
    removeNodeFromGraph(graph, 'ag');
    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toHaveLength(2);
  });

  test('unknown id is a safe no-op', () => {
    const next = removeNodeFromGraph(graph, 'nope');
    expect(next.nodes).toHaveLength(4);
    expect(next.edges).toHaveLength(2);
  });

  test('connectedEdgeIds reports both touching edges', () => {
    expect(new Set(connectedEdgeIds(graph, 'ag'))).toEqual(new Set(['e-in-ag', 'e-ag-out']));
    expect(connectedEdgeIds(graph, 'other')).toEqual([]);
  });
});

describe('shouldDeleteSelection (keyboard guard)', () => {
  test('Delete key deletes when not typing', () => {
    expect(shouldDeleteSelection({ key: 'Delete', editing: false })).toBe(true);
  });
  test('Backspace deletes when not typing', () => {
    expect(shouldDeleteSelection({ key: 'Backspace', editing: false })).toBe(true);
  });
  test('typing in a text field NEVER deletes the node (Backspace edits text)', () => {
    expect(shouldDeleteSelection({ key: 'Backspace', editing: true })).toBe(false);
    expect(shouldDeleteSelection({ key: 'Delete', editing: true })).toBe(false);
  });
  test('other keys never delete', () => {
    expect(shouldDeleteSelection({ key: 'a', editing: false })).toBe(false);
    expect(shouldDeleteSelection({ key: 'Enter', editing: false })).toBe(false);
  });
});
