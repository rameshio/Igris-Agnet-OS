import { describe, expect, test } from 'vitest';
import { flowOrder, runAgentFlow } from '@/lib/agents/flow-run';
import type { RuntimeAgent } from '@/lib/agents/runtime';

const agent = (id: string, name: string, transform: (msg: string) => string): RuntimeAgent => ({
  id,
  name,
  description: '',
  departmentId: 'dept-tech',
  run: async () => ({ ok: true, summary: transform('') }),
  respond: async (msg) => ({ ok: true, summary: transform(msg) }),
});

describe('flowOrder', () => {
  test('topological order along A → B → C', () => {
    const nodes = [{ id: 'a', agentId: 'x' }, { id: 'b', agentId: 'x' }, { id: 'c', agentId: 'x' }];
    const edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
    expect(flowOrder(nodes, edges)).toEqual(['a', 'b', 'c']);
  });

  test('nodes caught in a cycle are still included (run never stalls)', () => {
    const nodes = [{ id: 'a', agentId: 'x' }, { id: 'b', agentId: 'x' }];
    const edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }];
    expect([...flowOrder(nodes, edges)].sort()).toEqual(['a', 'b']);
  });
});

describe('runAgentFlow', () => {
  test('chains outputs: the target agent receives the source agent output as input', async () => {
    const saved: string[] = [];
    const A = agent('a', 'A', () => 'HELLO');
    const B = agent('b', 'B', (msg) => `B(${msg})`);
    const nodes = [{ id: 'n1', agentId: 'a' }, { id: 'n2', agentId: 'b' }];
    const edges = [{ source: 'n1', target: 'n2' }];
    const res = await runAgentFlow(nodes, edges, { agents: [A, B], save: (_t, note) => saved.push(note) });
    expect(res.ok).toBe(true);
    expect(res.steps.map((s) => s.output)).toEqual(['HELLO', 'B(HELLO)']);
    expect(saved).toEqual(['HELLO', 'B(HELLO)']); // every step written to G-Brain
  });

  test('a node with an unknown agent fails honestly without crashing the flow', async () => {
    const res = await runAgentFlow([{ id: 'n1', agentId: 'ghost' }], [], { agents: [], save: () => {} });
    expect(res.ok).toBe(false);
    expect(res.steps[0].ok).toBe(false);
    expect(res.steps[0].output).toMatch(/not found/);
  });

  test('a start node (no incoming edge) is fed the seed instruction', async () => {
    let received = '';
    const A = agent('a', 'A', (m) => { received = m; return 'x'; });
    await runAgentFlow([{ id: 'n1', agentId: 'a' }], [], { agents: [A], save: () => {} }, { initialInput: 'GO' });
    expect(received).toBe('GO');
  });
});
