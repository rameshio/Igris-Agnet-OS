import { describe, expect, test } from 'vitest';
import { validateWorkflowGraph } from '@/lib/flows/validator';

const agentNode = (id: string, agentId = 'a1', x = 0, y = 0) => ({ id, type: 'agent' as const, x, y, config: { agentId } });

describe('validateWorkflowGraph (v1)', () => {
  test('a clean DAG is valid', () => {
    const res = validateWorkflowGraph(
      { nodes: [agentNode('n1'), agentNode('n2')], edges: [{ id: 'e1', source: 'n1', target: 'n2' }] },
      { agentIds: new Set(['a1']) },
    );
    expect(res.ok).toBe(true);
    expect(res.issues).toHaveLength(0);
  });

  test('flags duplicate node ids', () => {
    const res = validateWorkflowGraph({ nodes: [agentNode('n1'), agentNode('n1')], edges: [] });
    expect(res.issues.some((i) => i.code === 'duplicate_node_id')).toBe(true);
  });

  test('flags a dangling edge', () => {
    const res = validateWorkflowGraph({ nodes: [agentNode('n1')], edges: [{ id: 'e1', source: 'n1', target: 'ghost' }] });
    expect(res.issues.some((i) => i.code === 'dangling_edge')).toBe(true);
  });

  test('flags a self-edge', () => {
    const res = validateWorkflowGraph({ nodes: [agentNode('n1')], edges: [{ id: 'e1', source: 'n1', target: 'n1' }] });
    expect(res.issues.some((i) => i.code === 'self_edge')).toBe(true);
  });

  test('flags a missing agent reference', () => {
    const res = validateWorkflowGraph({ nodes: [agentNode('n1', 'ghost')], edges: [] }, { agentIds: new Set(['a1']) });
    expect(res.issues.some((i) => i.code === 'missing_agent')).toBe(true);
  });

  test('flags a cycle', () => {
    const res = validateWorkflowGraph({
      nodes: [agentNode('n1'), agentNode('n2')],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n1' },
      ],
    });
    expect(res.issues.some((i) => i.code === 'cycle')).toBe(true);
  });

  test('flags a malformed graph', () => {
    const res = validateWorkflowGraph({ nodes: [{ id: 'n1', type: 'nope', x: 0, y: 0, config: {} }], edges: [] });
    expect(res.ok).toBe(false);
    expect(res.issues[0].code).toBe('malformed');
  });

  test('requireNonEmpty flags an empty workflow', () => {
    const res = validateWorkflowGraph({ nodes: [], edges: [] }, { requireNonEmpty: true });
    expect(res.issues.some((i) => i.code === 'empty')).toBe(true);
  });
});
