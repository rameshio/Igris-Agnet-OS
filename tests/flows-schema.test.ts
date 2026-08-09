import { describe, expect, test } from 'vitest';
import {
  WorkflowNodeSchema,
  WorkflowEdgeSchema,
  WorkflowDefinitionSchema,
  WorkflowGraphSchema,
} from '@/lib/flows/schema';

describe('workflow schema', () => {
  test('parses an agent node with its config', () => {
    const node = WorkflowNodeSchema.parse({ id: 'n1', type: 'agent', x: 10, y: 20, config: { agentId: 'a1' } });
    expect(node.type).toBe('agent');
    if (node.type === 'agent') expect(node.config.agentId).toBe('a1');
  });

  test('agent node requires an agentId', () => {
    expect(() => WorkflowNodeSchema.parse({ id: 'n1', type: 'agent', x: 0, y: 0, config: {} })).toThrow();
  });

  test('discriminated union rejects an unknown node type', () => {
    expect(() => WorkflowNodeSchema.parse({ id: 'n1', type: 'wizard', x: 0, y: 0, config: {} })).toThrow();
  });

  test('every known node type parses with its default config', () => {
    const types = ['input', 'tool', 'decision', 'approval', 'memory', 'transform', 'parallel', 'join', 'output'] as const;
    for (const type of types) {
      const parsed = WorkflowNodeSchema.parse({ id: `n-${type}`, type, x: 0, y: 0, config: {} });
      expect(parsed.type).toBe(type);
    }
  });

  test('edge defaults mapping to whole-output', () => {
    const edge = WorkflowEdgeSchema.parse({ id: 'e1', source: 'a', target: 'b' });
    expect(edge.mapping.mode).toBe('all');
  });

  test('graph + definition round-trip through the schema', () => {
    const graph = WorkflowGraphSchema.parse({
      nodes: [{ id: 'n1', type: 'agent', x: 0, y: 0, config: { agentId: 'a1' } }],
      edges: [{ id: 'e1', source: 'n1', target: 'n1' }],
    });
    expect(graph.nodes).toHaveLength(1);
    const def = WorkflowDefinitionSchema.parse({ id: 'wf1', name: 'Test', nodes: graph.nodes, edges: graph.edges });
    expect(def.version).toBe(0);
    expect(def.description).toBe('');
  });
});
