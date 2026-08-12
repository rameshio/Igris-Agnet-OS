import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import { createCustomAgent } from '@/lib/agents/custom';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { executeRun } from '@/lib/flows/engine';
import type { FlowRun } from '@/lib/flows/run-types';

const prevLlm = process.env.LLM_PROVIDER;
beforeAll(() => {
  process.env.LLM_PROVIDER = 'stub';
});
afterAll(() => {
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
});

const G = (nodes: unknown[], edges: unknown[]): WorkflowGraph => WorkflowGraphSchema.parse({ nodes, edges });
const input = (id: string) => ({ id, type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } });
const agent = (id: string, agentId: string) => ({ id, type: 'agent', x: 0, y: 0, config: { agentId } });
const output = (id: string) => ({ id, type: 'output', x: 0, y: 0, config: { mode: 'display' } });
const transform = (id: string, config: unknown) => ({ id, type: 'transform', x: 0, y: 0, config });
const decision = (id: string, config: unknown) => ({ id, type: 'decision', x: 0, y: 0, config });
const parallel = (id: string) => ({ id, type: 'parallel', x: 0, y: 0, config: {} });
const join = (id: string) => ({ id, type: 'join', x: 0, y: 0, config: {} });
const edge = (id: string, s: string, t: string, extra: Record<string, unknown> = {}) => ({ id, source: s, target: t, ...extra });

let counter = 0;
function newRun(db: ReturnType<typeof openDb>, text = ''): FlowRun {
  return db.flowRuns.create({ id: `run-${++counter}`, workflowId: 'wf', workflowVersion: 1, startingInput: { text } });
}
function makeAgent(db: ReturnType<typeof openDb>, name: string) {
  return createCustomAgent(db, { name, departmentId: 'dept-comms', instructions: 'Be helpful.', model: '', tools: [], enabled: true });
}
const nodeMap = (db: ReturnType<typeof openDb>, runId: string) =>
  Object.fromEntries(db.flowNodeRuns.forRun(runId).map((n) => [n.nodeId, n]));

describe('Decision routing (Phase D)', () => {
  test('first-match selects a route; unselected branch is skipped, run succeeds', async () => {
    const db = openDb(':memory:');
    const g = G(
      [
        input('i'),
        transform('tr', { mode: 'field', field: '{{i.text}}' }),
        decision('d', { rules: [{ route: 'yes', condition: { left: '{{tr.data}}', operator: 'greater_than_or_equal', right: 75 } }], defaultRoute: 'no' }),
        output('good'),
        output('low'),
      ],
      [edge('e1', 'i', 'tr'), edge('e2', 'tr', 'd'), edge('e3', 'd', 'good', { sourceHandle: 'yes' }), edge('e4', 'd', 'low', { sourceHandle: 'no' })],
    );
    const run = newRun(db, '82');
    await executeRun(db, run, g, allRuntimeAgents(db));
    const byNode = nodeMap(db, run.id);
    expect(byNode.d.status).toBe('success');
    expect((byNode.d.output!.data as { selectedRoute: string }).selectedRoute).toBe('yes');
    expect(byNode.good.status).toBe('success');
    expect(byNode.low.status).toBe('skipped');
    expect(byNode.low.errorCode).toBe('branch_not_selected');
    expect(db.flowRuns.get(run.id)!.status).toBe('success');
  });

  test('default route taken when no rule matches (LOW path)', async () => {
    const db = openDb(':memory:');
    const g = G(
      [
        input('i'),
        transform('tr', { mode: 'field', field: '{{i.text}}' }),
        decision('d', { rules: [{ route: 'yes', condition: { left: '{{tr.data}}', operator: 'greater_than_or_equal', right: 75 } }], defaultRoute: 'no' }),
        output('good'),
        output('low'),
      ],
      [edge('e1', 'i', 'tr'), edge('e2', 'tr', 'd'), edge('e3', 'd', 'good', { sourceHandle: 'yes' }), edge('e4', 'd', 'low', { sourceHandle: 'no' })],
    );
    const run = newRun(db, '40');
    await executeRun(db, run, g, allRuntimeAgents(db));
    const byNode = nodeMap(db, run.id);
    expect((byNode.d.output!.data as { selectedRoute: string }).selectedRoute).toBe('no');
    expect(byNode.low.status).toBe('success');
    expect(byNode.good.status).toBe('skipped');
  });

  test('no matching rule and no default → decision_no_route, run fails', async () => {
    const db = openDb(':memory:');
    const g = G(
      [input('i'), decision('d', { rules: [{ route: 'yes', condition: { left: '{{i.text}}', operator: 'equals', right: 'NOPE' } }] }), output('o')],
      [edge('e1', 'i', 'd'), edge('e2', 'd', 'o', { sourceHandle: 'yes' })],
    );
    const run = newRun(db, 'HIGH');
    await executeRun(db, run, g, allRuntimeAgents(db));
    const byNode = nodeMap(db, run.id);
    expect(byNode.d.status).toBe('failed');
    expect(byNode.d.errorCode).toBe('decision_no_route');
    expect(byNode.o.status).toBe('skipped');
    expect(db.flowRuns.get(run.id)!.status).toBe('failed');
  });
});

describe('Conditional edges (Phase D)', () => {
  test('true condition activates its edge; false condition skips its downstream', async () => {
    const db = openDb(':memory:');
    const g = G(
      [input('i'), transform('tr', { mode: 'object', object: { confidence: '0.9' } }), output('A'), output('B')],
      [
        edge('e1', 'i', 'tr'),
        edge('e2', 'tr', 'A', { condition: { left: '{{tr.data.confidence}}', operator: 'greater_than_or_equal', right: 0.8 } }),
        edge('e3', 'tr', 'B', { condition: { left: '{{tr.data.confidence}}', operator: 'greater_than_or_equal', right: 0.95 } }),
      ],
    );
    const run = newRun(db, 'x');
    await executeRun(db, run, g, allRuntimeAgents(db));
    const byNode = nodeMap(db, run.id);
    expect(byNode.A.status).toBe('success');
    expect(byNode.B.status).toBe('skipped');
    expect(db.flowRuns.get(run.id)!.status).toBe('success');
  });
});

describe('Parallel / Join (Phase D)', () => {
  test('both branches execute; Join waits for both and merges deterministically', async () => {
    const db = openDb(':memory:');
    const a = makeAgent(db, 'WriterA');
    const b = makeAgent(db, 'WriterB');
    const g = G(
      [input('i'), parallel('p'), agent('A', a.id), agent('B', b.id), join('j'), output('o')],
      [
        edge('e1', 'i', 'p'),
        edge('e2', 'p', 'A'),
        edge('e3', 'p', 'B'),
        edge('e4', 'A', 'j', { targetHandle: 'resume' }),
        edge('e5', 'B', 'j', { targetHandle: 'cover' }),
        edge('e6', 'j', 'o'),
      ],
    );
    const run = newRun(db, 'go');
    await executeRun(db, run, g, allRuntimeAgents(db));
    const byNode = nodeMap(db, run.id);
    expect(byNode.A.status).toBe('success');
    expect(byNode.B.status).toBe('success');
    expect(byNode.j.status).toBe('success');
    const branches = (byNode.j.output!.data as { branches: Record<string, unknown> }).branches;
    expect(Object.keys(branches).sort()).toEqual(['cover', 'resume']);
    expect(byNode.o.status).toBe('success');
  });

  test('Decision → A/B → Join: skipped branch does not stall the Join', async () => {
    const db = openDb(':memory:');
    const a = makeAgent(db, 'AgentA');
    const b = makeAgent(db, 'AgentB');
    const g = G(
      [
        input('i'),
        decision('d', { rules: [{ route: 'A', condition: { left: '{{i.text}}', operator: 'equals', right: 'go-a' } }], defaultRoute: 'B' }),
        agent('A', a.id),
        agent('B', b.id),
        join('j'),
        output('o'),
      ],
      [
        edge('e1', 'i', 'd'),
        edge('e2', 'd', 'A', { sourceHandle: 'A' }),
        edge('e3', 'd', 'B', { sourceHandle: 'B' }),
        edge('e4', 'A', 'j', { targetHandle: 'a' }),
        edge('e5', 'B', 'j', { targetHandle: 'b' }),
        edge('e6', 'j', 'o'),
      ],
    );
    const run = newRun(db, 'go-a');
    await executeRun(db, run, g, allRuntimeAgents(db));
    const byNode = nodeMap(db, run.id);
    expect(byNode.A.status).toBe('success');
    expect(byNode.B.status).toBe('skipped');
    expect(byNode.j.status).toBe('success'); // did not wait forever for B
    const branches = (byNode.j.output!.data as { branches: Record<string, unknown> }).branches;
    expect(Object.keys(branches)).toEqual(['a']); // only the active branch
    expect(byNode.o.status).toBe('success');
    expect(db.flowRuns.get(run.id)!.status).toBe('success');
  });
});

describe('Phase D engine integration (§71/§82)', () => {
  function buildAndRun(db: ReturnType<typeof openDb>, startText: string) {
    const an = makeAgent(db, 'Analyzer');
    const wa = makeAgent(db, 'Writer A');
    const wb = makeAgent(db, 'Writer B');
    const rev = makeAgent(db, 'Reviewer');
    const g = G(
      [
        input('i'),
        agent('an', an.id),
        transform('tr', { mode: 'field', field: '{{i.text}}' }),
        decision('d', { rules: [{ route: 'HIGH', condition: { left: '{{tr.data}}', operator: 'greater_than_or_equal', right: 75 } }], defaultRoute: 'LOW' }),
        parallel('p'),
        agent('wa', wa.id),
        agent('wb', wb.id),
        join('j'),
        agent('rev', rev.id),
        output('hi'),
        output('lo'),
      ],
      [
        edge('e1', 'i', 'an'),
        edge('e2', 'an', 'tr'),
        edge('e3', 'tr', 'd'),
        edge('e4', 'd', 'p', { sourceHandle: 'HIGH' }),
        edge('e5', 'd', 'lo', { sourceHandle: 'LOW' }),
        edge('e6', 'p', 'wa'),
        edge('e7', 'p', 'wb'),
        edge('e8', 'wa', 'j', { targetHandle: 'a' }),
        edge('e9', 'wb', 'j', { targetHandle: 'b' }),
        edge('e10', 'j', 'rev'),
        edge('e11', 'rev', 'hi'),
      ],
    );
    const run = newRun(db, startText);
    return { g, run };
  }

  test('HIGH path runs parallel → join → reviewer → hi; skips LOW', async () => {
    const db = openDb(':memory:');
    const { g, run } = buildAndRun(db, '82');
    await executeRun(db, run, g, allRuntimeAgents(db));
    const byNode = nodeMap(db, run.id);
    expect(byNode.d.status).toBe('success');
    expect((byNode.d.output!.data as { selectedRoute: string }).selectedRoute).toBe('HIGH');
    for (const id of ['p', 'wa', 'wb', 'j', 'rev', 'hi']) expect(byNode[id].status).toBe('success');
    expect(byNode.lo.status).toBe('skipped');
    expect(db.flowRuns.get(run.id)!.status).toBe('success');
  });

  test('LOW path runs lo output and skips the whole HIGH subgraph', async () => {
    const db = openDb(':memory:');
    const { g, run } = buildAndRun(db, '40');
    await executeRun(db, run, g, allRuntimeAgents(db));
    const byNode = nodeMap(db, run.id);
    expect((byNode.d.output!.data as { selectedRoute: string }).selectedRoute).toBe('LOW');
    expect(byNode.lo.status).toBe('success');
    for (const id of ['p', 'wa', 'wb', 'j', 'rev', 'hi']) expect(byNode[id].status).toBe('skipped');
    expect(db.flowRuns.get(run.id)!.status).toBe('success');
  });
});
