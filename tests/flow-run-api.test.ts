import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDb } from '@/lib/data';
import { createCustomAgent } from '@/lib/agents/custom';
import { WorkflowGraphSchema } from '@/lib/flows/schema';

const prevLlm = process.env.LLM_PROVIDER;
beforeAll(() => {
  process.env.FOUNDER_OS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'igris-runapi-')), 'test.db');
  process.env.LLM_PROVIDER = 'stub';
});
afterAll(() => {
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
});

const graph = (agentId: string) =>
  WorkflowGraphSchema.parse({
    nodes: [
      { id: 'i', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
      { id: 'ag', type: 'agent', x: 100, y: 0, config: { agentId } },
      { id: 'o', type: 'output', x: 200, y: 0, config: { mode: 'display' } },
    ],
    edges: [
      { id: 'e1', source: 'i', target: 'ag' },
      { id: 'e2', source: 'ag', target: 'o' },
    ],
  });

function publishWorkflow(id: string, agentId: string, publish = true) {
  const db = getDb();
  db.flowWorkflows.create({ id, name: 'API WF', graph: graph(agentId) });
  if (publish) {
    db.flowVersions.create({ id: `${id}-v1`, workflowId: id, version: 1, graph: graph(agentId) });
    db.flowWorkflows.setCurrentVersion(id, 1);
  }
}

async function json(res: Response) {
  return res.json();
}

describe('flow run API (Phase C)', () => {
  test('POST starts a run of the published version; GET reflects completion', async () => {
    const db = getDb();
    const agent = createCustomAgent(db, { name: 'R', departmentId: 'dept-comms', instructions: 'Help.', model: '', tools: [], enabled: true });
    publishWorkflow('wf-run', agent.id);

    const { POST } = await import('@/app/api/flows/[id]/runs/route');
    const started = await json((await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ input: { text: 'hi' } }) }), { params: { id: 'wf-run' } })) as Response);
    expect(started.ok).toBe(true);
    expect(started.version).toBe(1);
    const runId = started.runId as string;

    const { GET } = await import('@/app/api/flows/runs/[runId]/route');
    let body: { run: { status: string }; nodeRuns: unknown[]; finalOutput: { text: string } | null } | undefined;
    for (let i = 0; i < 60; i++) {
      body = (await json((await GET(new Request('http://x'), { params: { runId } })) as Response)) as typeof body;
      if (['success', 'failed', 'interrupted'].includes(body!.run.status)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(body!.run.status).toBe('success');
    expect(body!.nodeRuns).toHaveLength(3);
    expect(body!.finalOutput?.text.length).toBeGreaterThan(0);
    // no raw secret anywhere
    expect(JSON.stringify(body)).not.toMatch(/authorization|bearer|api[_-]?key/i);
  });

  test('running an unpublished workflow → 409 publish-first', async () => {
    const db = getDb();
    const agent = createCustomAgent(db, { name: 'R2', departmentId: 'dept-comms', instructions: 'Help.', model: '', tools: [], enabled: true });
    publishWorkflow('wf-draft', agent.id, false); // no published version
    const { POST } = await import('@/app/api/flows/[id]/runs/route');
    const res = (await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ input: { text: 'hi' } }) }), { params: { id: 'wf-draft' } })) as Response;
    expect(res.status).toBe(409);
  });

  test('missing workflow → 404; nonexistent run → 404', async () => {
    const { POST, GET: HISTORY } = await import('@/app/api/flows/[id]/runs/route');
    expect(((await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ input: { text: 'x' } }) }), { params: { id: 'nope' } })) as Response).status).toBe(404);
    expect((HISTORY(new Request('http://x'), { params: { id: 'nope' } }) as Response).status).toBe(404);
    const { GET } = await import('@/app/api/flows/runs/[runId]/route');
    expect((GET(new Request('http://x'), { params: { runId: 'nope' } }) as Response).status).toBe(404);
  });

  test('history lists the workflow runs', async () => {
    const db = getDb();
    const agent = createCustomAgent(db, { name: 'R3', departmentId: 'dept-comms', instructions: 'Help.', model: '', tools: [], enabled: true });
    publishWorkflow('wf-hist', agent.id);
    const { POST, GET } = await import('@/app/api/flows/[id]/runs/route');
    await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ input: { text: 'a' } }) }), { params: { id: 'wf-hist' } });
    const body = await json((GET(new Request('http://x'), { params: { id: 'wf-hist' } })) as Response);
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs.length).toBeGreaterThanOrEqual(1);
    expect(body.runs[0].workflowVersion).toBe(1);
  });
});
