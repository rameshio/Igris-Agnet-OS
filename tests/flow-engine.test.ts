import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openDb } from '@/lib/db';
import { createCustomAgent } from '@/lib/agents/custom';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { executeRun, resolveIncomingInputs, topoOrder } from '@/lib/flows/engine';
import { validateExecutable } from '@/lib/flows/validator';
import type { FlowRun } from '@/lib/flows/run-types';

const prevLlm = process.env.LLM_PROVIDER;
beforeAll(() => {
  process.env.LLM_PROVIDER = 'stub';
});
afterAll(() => {
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NVIDIA_API_KEY;
});

const G = (nodes: unknown[], edges: unknown[]): WorkflowGraph => WorkflowGraphSchema.parse({ nodes, edges });
const input = (id: string, x = 0, y = 0) => ({ id, type: 'input', x, y, config: { value: '', format: 'text' } });
const agent = (id: string, agentId: string, x = 0, y = 0) => ({ id, type: 'agent', x, y, config: { agentId } });
const output = (id: string, x = 0, y = 0) => ({ id, type: 'output', x, y, config: { mode: 'display' } });
const edge = (id: string, s: string, t: string) => ({ id, source: s, target: t });

function newRun(db: ReturnType<typeof openDb>, text = 'Explain RAG'): FlowRun {
  return db.flowRuns.create({ id: 'run-1', workflowId: 'wf', workflowVersion: 1, startingInput: { text } });
}
function makeAgent(db: ReturnType<typeof openDb>, model: string, agentId = 'A') {
  return createCustomAgent(db, { name: agentId, departmentId: 'dept-comms', instructions: 'Be helpful.', model, tools: [], enabled: true });
}

describe('WorkflowEngine (Phase C)', () => {
  test('Input → Agent → Output happy path, output feeds from agent', async () => {
    const db = openDb(':memory:');
    const a = makeAgent(db, ''); // hermes → stub
    const g = G([input('i'), agent('ag', a.id), output('o')], [edge('e1', 'i', 'ag'), edge('e2', 'ag', 'o')]);
    await executeRun(db, newRun(db, 'Explain RAG'), g, allRuntimeAgents(db));

    const nrs = db.flowNodeRuns.forRun('run-1');
    const byNode = Object.fromEntries(nrs.map((n) => [n.nodeId, n])) as Record<string, (typeof nrs)[number]>;
    expect(byNode.i!.status).toBe('success');
    expect(byNode.ag!.status).toBe('success');
    expect(byNode.o!.status).toBe('success');
    expect(db.flowRuns.get('run-1')!.status).toBe('success');
    // Agent received the input node's text; output carries the agent's reply
    expect((byNode.ag!.input as { text: string }).text).toContain('Explain RAG');
    expect(byNode.o!.output!.text).toBe(byNode.ag!.output!.text);
  });

  test('execution order follows edges, not X/Y positions', async () => {
    const db = openDb(':memory:');
    const a = makeAgent(db, '');
    // output physically far left of input; edges still define order
    const g = G([output('o', 0, 0), agent('ag', a.id, 500, 0), input('i', 1000, 0)], [edge('e1', 'i', 'ag'), edge('e2', 'ag', 'o')]);
    await executeRun(db, newRun(db), g, allRuntimeAgents(db));
    const o = db.flowNodeRuns.forRun('run-1').find((n) => n.nodeId === 'o')!;
    expect(o.status).toBe('success');
    expect((o.output?.text ?? '').length).toBeGreaterThan(0);
  });

  test('persists ModelRouteResult metadata for the Hermes route', async () => {
    const db = openDb(':memory:');
    const a = makeAgent(db, '');
    const g = G([input('i'), agent('ag', a.id), output('o')], [edge('e1', 'i', 'ag'), edge('e2', 'ag', 'o')]);
    await executeRun(db, newRun(db), g, allRuntimeAgents(db));
    const ag = db.flowNodeRuns.forRun('run-1').find((n) => n.nodeId === 'ag')!;
    expect(ag.modelStrategy).toBe('hermes');
    expect(ag.adapter).toBe('brain:stub');
  });

  test('persists Fixed provider metadata (mocked NVIDIA)', async () => {
    const db = openDb(':memory:');
    process.env.NVIDIA_API_KEY = 'k';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'nv reply' } }], usage: { prompt_tokens: 4, completion_tokens: 6 } }) })));
    const a = makeAgent(db, 'nvidia:nemotron');
    const g = G([input('i'), agent('ag', a.id), output('o')], [edge('e1', 'i', 'ag'), edge('e2', 'ag', 'o')]);
    await executeRun(db, newRun(db), g, allRuntimeAgents(db));
    const ag = db.flowNodeRuns.forRun('run-1').find((n) => n.nodeId === 'ag')!;
    expect(ag.status).toBe('success');
    expect(ag.providerId).toBe('nvidia');
    expect(ag.modelId).toBe('nemotron');
    expect(ag.adapter).toBe('openai-compatible');
    expect(ag.totalTokens).toBe(10);
    expect(db.flowRuns.get('run-1')!.totalTokens).toBe(10);
  });

  test('Auto strategy fails the node honestly and fails the run', async () => {
    const db = openDb(':memory:');
    const a = makeAgent(db, 'auto');
    const g = G([input('i'), agent('ag', a.id), output('o')], [edge('e1', 'i', 'ag'), edge('e2', 'ag', 'o')]);
    await executeRun(db, newRun(db), g, allRuntimeAgents(db));
    const nrs = db.flowNodeRuns.forRun('run-1');
    const ag = nrs.find((n) => n.nodeId === 'ag')!;
    const o = nrs.find((n) => n.nodeId === 'o')!;
    expect(ag.status).toBe('failed');
    expect(ag.errorCode).toBe('auto_not_implemented');
    expect(o.status).toBe('skipped'); // downstream skipped
    expect(db.flowRuns.get('run-1')!.status).toBe('failed');
    expect(db.flowRuns.get('run-1')!.errorCode).toBe('auto_not_implemented');
  });

  test('missing agent fails the node with agent_not_found', async () => {
    const db = openDb(':memory:');
    const g = G([input('i'), agent('ag', 'ghost'), output('o')], [edge('e1', 'i', 'ag'), edge('e2', 'ag', 'o')]);
    await executeRun(db, newRun(db), g, allRuntimeAgents(db));
    expect(db.flowNodeRuns.forRun('run-1').find((n) => n.nodeId === 'ag')!.errorCode).toBe('agent_not_found');
  });

  test('provider error fails node + run (mocked 500)', async () => {
    const db = openDb(':memory:');
    process.env.NVIDIA_API_KEY = 'k';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, statusText: 'err', text: async () => 'server error' })));
    const a = makeAgent(db, 'nvidia:nemotron');
    const g = G([input('i'), agent('ag', a.id), output('o')], [edge('e1', 'i', 'ag'), edge('e2', 'ag', 'o')]);
    await executeRun(db, newRun(db), g, allRuntimeAgents(db));
    expect(db.flowNodeRuns.forRun('run-1').find((n) => n.nodeId === 'ag')!.status).toBe('failed');
    expect(db.flowRuns.get('run-1')!.status).toBe('failed');
  });

  test('validateExecutable rejects unsupported node types and missing output before running', () => {
    const okGraph = { nodes: [input('i'), agent('ag', 'A'), output('o')], edges: [edge('e1', 'i', 'ag'), edge('e2', 'ag', 'o')] };
    expect(validateExecutable(okGraph, { agentIds: new Set(['A']) }).ok).toBe(true);

    // memory remains unsupported until Phase F (approval became executable in Phase E)
    const memory = { nodes: [input('i'), { id: 'mem', type: 'memory', x: 0, y: 0, config: {} }, output('o')], edges: [edge('e1', 'i', 'mem'), edge('e2', 'mem', 'o')] };
    const r = validateExecutable(memory, {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'unsupported_node_type')).toBe(true);

    const noOut = { nodes: [input('i'), agent('ag', 'A')], edges: [edge('e1', 'i', 'ag')] };
    expect(validateExecutable(noOut, { agentIds: new Set(['A']) }).issues.some((i) => i.code === 'no_output')).toBe(true);
  });

  test('resolveIncomingInputs merges multiple predecessors deterministically (sorted by source id)', () => {
    const state = { b: { text: 'BBB' }, a: { text: 'AAA' } };
    const edges = [edge('e1', 'b', 't'), edge('e2', 'a', 't')].map((e) => ({ ...e, mapping: { mode: 'all' as const } }));
    const merged = resolveIncomingInputs('t', edges, state, { text: '' });
    expect(merged.text).toBe('AAA\n\nBBB'); // sorted a before b, stable
  });

  test('topoOrder respects dependencies', () => {
    const order = topoOrder(['o', 'ag', 'i'], [{ source: 'i', target: 'ag' }, { source: 'ag', target: 'o' }]);
    expect(order.indexOf('i')).toBeLessThan(order.indexOf('ag'));
    expect(order.indexOf('ag')).toBeLessThan(order.indexOf('o'));
  });

  test('the engine never auto-writes workflow output to G-Brain', () => {
    // Structural guard: neither the engine nor the agent executor imports the
    // knowledge write path. Memory is Phase F (explicit nodes only).
    const root = process.cwd();
    const engineSrc = readFileSync(path.join(root, 'lib/flows/engine.ts'), 'utf8');
    const agentSrc = readFileSync(path.join(root, 'lib/flows/executors/agent.ts'), 'utf8');
    for (const src of [engineSrc, agentSrc]) {
      expect(src).not.toMatch(/writeBrainDump|brain-dump/);
    }
  });
});
