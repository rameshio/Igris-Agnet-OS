/**
 * Phase E — Human Approval + durable pause/resume.
 *
 * Covers: the flow_approvals repo (incl. idempotent conditional resolve), the
 * engine pause at an approval node, resume routing (approve vs reject), that a
 * rejection is NOT a failure, that resume NEVER re-runs an upstream Agent node
 * (executor call count stays 1), restart durability (resume rebuilds state from
 * persistence; reconcile leaves a waiting run alone), and the approval service's
 * idempotency + security (a client cannot resolve a run other than the one the
 * approval belongs to; no secrets in the persisted context).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { openDb } from '@/lib/db';
import { createCustomAgent } from '@/lib/agents/custom';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { executeRun, resumeRun } from '@/lib/flows/engine';
import { agentExecutor } from '@/lib/flows/executors/agent';
import { reconcile, resumeRunBg, isActive } from '@/lib/flows/coordinator';
import { resolveApproval } from '@/lib/flows/approvals';
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

const G = (nodes: unknown[], edges: unknown[]): WorkflowGraph => WorkflowGraphSchema.parse({ nodes, edges });
const input = (id: string) => ({ id, type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } });
const agent = (id: string, agentId: string) => ({ id, type: 'agent', x: 0, y: 0, config: { agentId } });
const output = (id: string) => ({ id, type: 'output', x: 0, y: 0, config: { mode: 'display' } });
const approval = (id: string, config: unknown) => ({ id, type: 'approval', x: 0, y: 0, config });
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

const APPR_CFG = { title: 'Approve?', message: 'Approve this step', approveRoute: 'approve', rejectRoute: 'reject', approveLabel: 'Approve', rejectLabel: 'Reject', contextFields: [] };

/**
 * input → agent → approval → (approve) okOut / (reject) noOut.
 * Published as an immutable version so resumeRun can reload it from the DB alone
 * (the durability contract: resume never depends on in-memory graph state).
 */
function gateGraph(db: ReturnType<typeof openDb>) {
  const a = makeAgent(db, 'Analyzer');
  const g = G(
    [input('i'), agent('a', a.id), approval('ap', APPR_CFG), output('ok'), output('no')],
    [
      edge('e1', 'i', 'a'),
      edge('e2', 'a', 'ap'),
      edge('e3', 'ap', 'ok', { sourceHandle: 'approve' }),
      edge('e4', 'ap', 'no', { sourceHandle: 'reject' }),
    ],
  );
  if (!db.flowWorkflows.get('wf')) db.flowWorkflows.create({ id: 'wf', name: 'wf', graph: g });
  if (!db.flowVersions.get('wf', 1)) db.flowVersions.create({ id: 'wf-v1', workflowId: 'wf', version: 1, graph: g });
  return g;
}

describe('flow_approvals repository', () => {
  test('create → pending / forRun / latestForNodeRun; resolve is idempotent', () => {
    const db = openDb(':memory:');
    const run = newRun(db);
    const appr = db.flowApprovals.create({
      id: 'appr-1',
      runId: run.id,
      nodeRunId: 'nr-1',
      workflowId: 'wf',
      workflowVersion: 1,
      nodeId: 'ap',
      title: 'T',
      message: 'M',
      context: { inputText: 'hi' },
      approvalRoute: 'approve',
      rejectionRoute: 'reject',
    });
    expect(appr.status).toBe('pending');
    expect(db.flowApprovals.pending().map((a) => a.id)).toContain('appr-1');
    expect(db.flowApprovals.forRun(run.id)).toHaveLength(1);
    expect(db.flowApprovals.latestForNodeRun('nr-1')!.id).toBe('appr-1');

    const first = db.flowApprovals.resolve('appr-1', 'approved', 'local_operator', 'looks good');
    expect(first!.status).toBe('approved');
    expect(first!.resolvedBy).toBe('local_operator');
    // Second resolve of the same (now non-pending) row does nothing — one execution.
    const second = db.flowApprovals.resolve('appr-1', 'rejected', 'someone', null);
    expect(second).toBeNull();
    expect(db.flowApprovals.get('appr-1')!.status).toBe('approved'); // unchanged
    expect(db.flowApprovals.pending()).toHaveLength(0);
  });

  test('cancelForRun cancels only pending rows', () => {
    const db = openDb(':memory:');
    const run = newRun(db);
    db.flowApprovals.create({ id: 'a1', runId: run.id, nodeRunId: null, workflowId: 'wf', workflowVersion: 1, nodeId: 'ap', title: '', message: '', approvalRoute: 'approve', rejectionRoute: 'reject' });
    db.flowApprovals.resolve('a1', 'approved', 'op', null);
    db.flowApprovals.create({ id: 'a2', runId: run.id, nodeRunId: null, workflowId: 'wf', workflowVersion: 1, nodeId: 'ap2', title: '', message: '', approvalRoute: 'approve', rejectionRoute: 'reject' });
    const cancelled = db.flowApprovals.cancelForRun(run.id, 'op');
    expect(cancelled).toBe(1); // only the still-pending a2
    expect(db.flowApprovals.get('a1')!.status).toBe('approved');
    expect(db.flowApprovals.get('a2')!.status).toBe('cancelled');
  });
});

describe('engine pause at Human Approval node', () => {
  test('run pauses: status waiting_approval, a pending approval exists, downstream not run', async () => {
    const db = openDb(':memory:');
    const g = gateGraph(db);
    const run = newRun(db, 'go');
    await executeRun(db, run, g, allRuntimeAgents(db));

    expect(db.flowRuns.get(run.id)!.status).toBe('waiting_approval');
    const byNode = nodeMap(db, run.id);
    expect(byNode.a.status).toBe('success'); // upstream agent ran
    expect(byNode.ap.status).toBe('waiting_approval');
    expect(['queued', undefined]).toContain(byNode.ok?.status); // downstream did not run
    const pending = db.flowApprovals.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].nodeId).toBe('ap');
    expect(pending[0].approvalRoute).toBe('approve');
  });

  test('a paused run is NOT the same as failed, and carries no error', async () => {
    const db = openDb(':memory:');
    const run = newRun(db, 'go');
    await executeRun(db, run, gateGraph(db), allRuntimeAgents(db));
    const r = db.flowRuns.get(run.id)!;
    expect(r.status).toBe('waiting_approval');
    expect(r.errorCode).toBeNull();
  });
});

describe('resume routing + no upstream rerun', () => {
  test('APPROVE resumes down the approve route; the Agent node is NEVER re-run', async () => {
    const db = openDb(':memory:');
    const g = gateGraph(db);
    const run = newRun(db, 'go');
    const spy = vi.spyOn(agentExecutor as Required<typeof agentExecutor>, 'execute');
    try {
      await executeRun(db, run, g, allRuntimeAgents(db));
      expect(spy).toHaveBeenCalledTimes(1); // agent ran exactly once before the pause

      const appr = db.flowApprovals.pending()[0];
      db.flowApprovals.resolve(appr.id, 'approved', 'local_operator', null);
      await resumeRun(db, run.id, allRuntimeAgents(db));

      expect(spy).toHaveBeenCalledTimes(1); // STILL once — resume did not re-call the agent
      const byNode = nodeMap(db, run.id);
      expect(byNode.ap.status).toBe('success');
      expect((byNode.ap.output!.data as { selectedRoute: string }).selectedRoute).toBe('approve');
      expect(byNode.ok.status).toBe('success');
      expect(byNode.no.status).toBe('skipped');
      expect(byNode.no.errorCode).toBe('branch_not_selected');
      expect(db.flowRuns.get(run.id)!.status).toBe('success');
    } finally {
      spy.mockRestore();
    }
  });

  test('REJECT resumes down the reject route; rejection is a normal outcome, not a failure', async () => {
    const db = openDb(':memory:');
    const g = gateGraph(db);
    const run = newRun(db, 'go');
    await executeRun(db, run, g, allRuntimeAgents(db));
    const appr = db.flowApprovals.pending()[0];
    db.flowApprovals.resolve(appr.id, 'rejected', 'local_operator', 'no thanks');
    await resumeRun(db, run.id, allRuntimeAgents(db));

    const byNode = nodeMap(db, run.id);
    expect(byNode.ap.status).toBe('rejected'); // distinct node status, NOT 'failed'
    expect((byNode.ap.output!.data as { selectedRoute: string }).selectedRoute).toBe('reject');
    expect(byNode.no.status).toBe('success');
    expect(byNode.ok.status).toBe('skipped');
    const r = db.flowRuns.get(run.id)!;
    expect(r.status).toBe('success'); // the run completed normally down the reject branch
    expect(r.errorCode).toBeNull();
  });
});

describe('durability + idempotency', () => {
  test('resume rebuilds state from persistence alone (restart scenario)', async () => {
    const db = openDb(':memory:');
    const run = newRun(db, 'go');
    await executeRun(db, run, gateGraph(db), allRuntimeAgents(db));
    // Simulate a process restart: nothing survives except the DB rows. Resolve and
    // resume with a completely fresh call — resumeRun reads only from SQLite.
    const appr = db.flowApprovals.pending()[0];
    db.flowApprovals.resolve(appr.id, 'approved', 'local_operator', null);
    await resumeRun(db, run.id, allRuntimeAgents(db));
    expect(db.flowRuns.get(run.id)!.status).toBe('success');
    expect(nodeMap(db, run.id).ok.status).toBe('success');
  });

  test('resuming a run twice is a no-op the second time (run already resolved)', async () => {
    const db = openDb(':memory:');
    const run = newRun(db, 'go');
    await executeRun(db, run, gateGraph(db), allRuntimeAgents(db));
    const appr = db.flowApprovals.pending()[0];
    db.flowApprovals.resolve(appr.id, 'approved', 'local_operator', null);
    await resumeRun(db, run.id, allRuntimeAgents(db));
    expect(db.flowRuns.get(run.id)!.status).toBe('success');
    // Second resume: status is no longer waiting_approval → immediate no-op.
    const spy = vi.spyOn(agentExecutor as Required<typeof agentExecutor>, 'execute');
    try {
      await resumeRun(db, run.id, allRuntimeAgents(db));
      expect(spy).not.toHaveBeenCalled();
      expect(db.flowRuns.get(run.id)!.status).toBe('success');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('coordinator: waiting runs survive restart; resume launcher', () => {
  test('reconcile() does NOT interrupt a waiting_approval run', async () => {
    const db = openDb(':memory:');
    const run = newRun(db, 'go');
    await executeRun(db, run, gateGraph(db), allRuntimeAgents(db));
    expect(db.flowRuns.get(run.id)!.status).toBe('waiting_approval');
    // reconcile only touches `running` runs not active in-process — a paused run is safe.
    const after = reconcile(db, run.id)!;
    expect(after.status).toBe('waiting_approval');
  });

  test('resumeRunBg launches once for a waiting run, then completes it', async () => {
    const db = openDb(':memory:');
    const run = newRun(db, 'go');
    await executeRun(db, run, gateGraph(db), allRuntimeAgents(db));
    const appr = db.flowApprovals.pending()[0];
    db.flowApprovals.resolve(appr.id, 'approved', 'local_operator', null);

    const launched = resumeRunBg(db, run.id, allRuntimeAgents(db));
    expect(launched).toBe(true);

    // Wait for the fire-and-forget resume to finish.
    for (let i = 0; i < 50 && db.flowRuns.get(run.id)!.status !== 'success'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(db.flowRuns.get(run.id)!.status).toBe('success');
    expect(isActive(run.id)).toBe(false); // released after completion
  });

  test('resumeRunBg returns false when the run is not waiting_approval', async () => {
    const db = openDb(':memory:');
    const run = newRun(db, 'go'); // still queued
    expect(resumeRunBg(db, run.id, allRuntimeAgents(db))).toBe(false);
  });
});

describe('approval service: backend-authoritative + idempotent', () => {
  test('resolveApproval resolves the approval, resumes ITS run, and is idempotent', async () => {
    const db = openDb(':memory:');
    const run = newRun(db, 'go');
    await executeRun(db, run, gateGraph(db), allRuntimeAgents(db));
    const appr = db.flowApprovals.pending()[0];

    const first = resolveApproval(db, appr.id, 'approved', { note: 'ok' });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.approval.runId).toBe(run.id); // resumed the approval's OWN run

    // A second resolve (double-click / race) does not re-resolve or re-run.
    const second = resolveApproval(db, appr.id, 'rejected', { note: 'changed mind' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('already_resolved');
    expect(db.flowApprovals.get(appr.id)!.status).toBe('approved'); // unchanged
  });

  test('resolveApproval on an unknown id is not_found (a client cannot fabricate one)', () => {
    const db = openDb(':memory:');
    const res = resolveApproval(db, 'does-not-exist', 'approved');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_found');
  });

  test('no secrets leak into the persisted approval context', async () => {
    const db = openDb(':memory:');
    const run = newRun(db, 'go');
    await executeRun(db, run, gateGraph(db), allRuntimeAgents(db));
    const appr = db.flowApprovals.pending()[0];
    const serialized = JSON.stringify(appr.context ?? {}).toLowerCase();
    for (const banned of ['api_key', 'apikey', 'authorization', 'bearer', 'password', 'secret', 'token']) {
      expect(serialized).not.toContain(banned);
    }
  });
});

describe('validator: an approval workflow is runnable (Phase E)', () => {
  test('validateExecutable passes for input → approval → output', () => {
    const db = openDb(':memory:');
    const g = G(
      [input('i'), approval('ap', APPR_CFG), output('ok'), output('no')],
      [edge('e1', 'i', 'ap'), edge('e2', 'ap', 'ok', { sourceHandle: 'approve' }), edge('e3', 'ap', 'no', { sourceHandle: 'reject' })],
    );
    const agentIds = new Set(allRuntimeAgents(db).map((a) => a.id));
    const result = validateExecutable(g, { agentIds });
    expect(result.ok).toBe(true);
  });
});
