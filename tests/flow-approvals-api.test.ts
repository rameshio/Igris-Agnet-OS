/**
 * Phase E — approval API routes (HTTP contract). Exercises the real Next.js route
 * handlers end to end: start a workflow that pauses on a Human Approval node,
 * see it in the inbox + run inspector, approve it over HTTP, and watch the run
 * resume to success. The client sends only the approval id + decision + note.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDb } from '@/lib/data';
import { createCustomAgent } from '@/lib/agents/custom';
import { WorkflowGraphSchema } from '@/lib/flows/schema';

const prevLlm = process.env.LLM_PROVIDER;
beforeAll(() => {
  process.env.FOUNDER_OS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'igris-apprapi-')), 'test.db');
  process.env.LLM_PROVIDER = 'stub';
});
afterAll(() => {
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
});

const gate = (agentId: string) =>
  WorkflowGraphSchema.parse({
    nodes: [
      { id: 'i', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
      { id: 'a', type: 'agent', x: 100, y: 0, config: { agentId } },
      { id: 'ap', type: 'approval', x: 200, y: 0, config: { title: 'Send it?', message: 'Approve', approveRoute: 'approve', rejectRoute: 'reject' } },
      { id: 'ok', type: 'output', x: 300, y: 0, config: { mode: 'display' } },
      { id: 'no', type: 'output', x: 300, y: 90, config: { mode: 'display' } },
    ],
    edges: [
      { id: 'e1', source: 'i', target: 'a' },
      { id: 'e2', source: 'a', target: 'ap' },
      { id: 'e3', source: 'ap', target: 'ok', sourceHandle: 'approve' },
      { id: 'e4', source: 'ap', target: 'no', sourceHandle: 'reject' },
    ],
  });

const json = (res: Response) => res.json();

describe('approval API (Phase E)', () => {
  test('pause → inbox → approve → resume to success, over HTTP', async () => {
    const db = getDb();
    const agent = createCustomAgent(db, { name: 'A', departmentId: 'dept-comms', instructions: 'Help.', model: '', tools: [], enabled: true });
    db.flowWorkflows.create({ id: 'wf-appr', name: 'Appr WF', graph: gate(agent.id) });
    db.flowVersions.create({ id: 'wf-appr-v1', workflowId: 'wf-appr', version: 1, graph: gate(agent.id) });
    db.flowWorkflows.setCurrentVersion('wf-appr', 1);

    const { POST: START } = await import('@/app/api/flows/[id]/runs/route');
    const started = await json((await START(new Request('http://x', { method: 'POST', body: JSON.stringify({ input: { text: 'hi' } }) }), { params: { id: 'wf-appr' } })) as Response);
    expect(started.ok).toBe(true);
    const runId = started.runId as string;

    // The run inspector shows it waiting, with the approval attached.
    const { GET: RUN } = await import('@/app/api/flows/runs/[runId]/route');
    let runBody: { run: { status: string }; approvals: { id: string; status: string }[] } | undefined;
    for (let i = 0; i < 60; i++) {
      runBody = (await json((await RUN(new Request('http://x'), { params: { runId } })) as Response)) as typeof runBody;
      if (runBody!.run.status === 'waiting_approval') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runBody!.run.status).toBe('waiting_approval');
    expect(runBody!.approvals.some((a) => a.status === 'pending')).toBe(true);

    // The inbox lists the pending approval.
    const { GET: INBOX } = await import('@/app/api/flow-approvals/route');
    const inbox = await json((await INBOX()) as Response);
    const pending = inbox.approvals.find((a: { id: string }) => a.id === runBody!.approvals[0].id);
    expect(pending).toBeTruthy();

    // Approve over HTTP — client sends only the decision + note.
    const { POST: APPROVE } = await import('@/app/api/flow-approvals/[id]/approve/route');
    const approveRes = await json(
      (await APPROVE(new Request('http://x', { method: 'POST', body: JSON.stringify({ note: 'go' }) }), { params: { id: pending.id } })) as Response,
    );
    expect(approveRes.ok).toBe(true);

    // The run resumes to success down the approve route.
    let finalStatus = '';
    for (let i = 0; i < 60; i++) {
      const b = (await json((await RUN(new Request('http://x'), { params: { runId } })) as Response)) as { run: { status: string } };
      finalStatus = b.run.status;
      if (['success', 'failed', 'interrupted'].includes(finalStatus)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(finalStatus).toBe('success');

    // Approving again is idempotent (already resolved), never a hard error.
    const again = await json(
      (await APPROVE(new Request('http://x', { method: 'POST', body: JSON.stringify({}) }), { params: { id: pending.id } })) as Response,
    );
    expect(again.ok).toBe(true);
    expect(again.alreadyResolved).toBe(true);
  });

  test('unknown approval id → 404', async () => {
    const { POST: APPROVE } = await import('@/app/api/flow-approvals/[id]/approve/route');
    const res = (await APPROVE(new Request('http://x', { method: 'POST', body: JSON.stringify({}) }), { params: { id: 'nope' } })) as Response;
    expect(res.status).toBe(404);
  });
});
