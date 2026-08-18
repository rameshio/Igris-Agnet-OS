/**
 * UX Foundation U6 — Commander Home service (composed over the real repos).
 *
 * Verifies the snapshot COMPOSES existing state correctly: pending approvals
 * (U5 safe projection), truly-active runs only under Running (waiting_approval
 * counted as active but NOT shown as running), the defined recent-failure
 * window, the bounded recent feed (U4), first-run vs populated, and that NO raw
 * payload / context_json ever reaches the snapshot.
 */
import { describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { buildHomeSnapshot } from '@/lib/home/service';

const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const G = (nodes: unknown[], edges: unknown[]): WorkflowGraph => WorkflowGraphSchema.parse({ nodes, edges });

function seedWf(db: ReturnType<typeof openDb>) {
  const g = G(
    [
      { id: 'i', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
      { id: 'ap', type: 'approval', x: 0, y: 0, config: { title: 't', message: '', approveRoute: 'approve', rejectRoute: 'reject' } },
      { id: 'ok', type: 'output', x: 0, y: 0, config: { mode: 'display' } },
    ],
    [{ id: 'e', source: 'ap', target: 'ok', sourceHandle: 'approve' }],
  );
  db.flowWorkflows.create({ id: 'wf', name: 'Gmail Daily', graph: g });
  db.flowVersions.create({ id: 'wf-v1', workflowId: 'wf', version: 1, graph: g });
}

function mkRun(db: ReturnType<typeof openDb>, id: string, status: string, endedMsAgo: number | null) {
  db.flowRuns.create({ id, workflowId: 'wf', workflowVersion: 1, startingInput: { text: '' } });
  db.flowRuns.update(id, { status: status as never, startedAt: ago(60_000), endedAt: endedMsAgo == null ? null : ago(endedMsAgo) });
}

describe('buildHomeSnapshot — empty workspace', () => {
  test('fresh db → first-run, everything empty, honest zero counts', () => {
    const db = openDb(':memory:');
    const s = buildHomeSnapshot(db, { now: NOW });
    expect(s.firstRun).toBe(true);
    expect(s.pendingApprovals).toEqual([]);
    expect(s.running).toEqual([]);
    expect(s.attention).toEqual([]);
    expect(s.recent).toEqual([]);
    expect(s.system.pendingApprovalCount).toBe(0);
    expect(s.system.activeRunCount).toBe(0);
    expect(s.system.recentFailureCount).toBe(0);
    expect(s.system.agentCount).toBe(allRuntimeAgents(db).length);
    expect(s.system.agentCount).toBeGreaterThan(0);
    expect(['ok', 'warn', 'err', 'unknown', 'stub']).toContain(s.system.hermes.state);
  });
});

describe('buildHomeSnapshot — populated workspace', () => {
  function seed() {
    const db = openDb(':memory:');
    seedWf(db);
    // pending approval on a waiting run, with a context leak-canary
    db.flowRuns.create({ id: 'run-appr', workflowId: 'wf', workflowVersion: 1, startingInput: { text: '' } });
    db.flowRuns.update('run-appr', { status: 'waiting_approval' as never });
    db.flowApprovals.create({
      id: 'appr-1', runId: 'run-appr', nodeRunId: null, workflowId: 'wf', workflowVersion: 1, nodeId: 'ap',
      title: 'Send it?', message: 'Send the drafted reply', context: { secret: 'DO-NOT-LEAK' }, approvalRoute: 'approve', rejectionRoute: 'reject',
    });
    mkRun(db, 'run-run', 'running', null); // genuinely active
    mkRun(db, 'run-failnew', 'failed', 60 * 60 * 1000); // failed 1h ago (recent)
    mkRun(db, 'run-failold', 'failed', 48 * 60 * 60 * 1000); // failed 48h ago (outside window)
    mkRun(db, 'run-ok', 'success', 30 * 60 * 1000);
    return db;
  }

  test('pending approvals come from the U5 safe projection (name + risk, no context)', () => {
    const s = buildHomeSnapshot(seed(), { now: NOW });
    expect(s.pendingApprovals.map((a) => a.approvalId)).toEqual(['appr-1']);
    expect(s.pendingApprovals[0].workflowName).toBe('Gmail Daily');
    expect(s.pendingApprovals[0].risk).toBe('low'); // approve → display output = internal
    expect(s.system.pendingApprovalCount).toBe(1);
  });

  test('Running shows only truly-active runs; waiting_approval is NOT running but IS active', () => {
    const s = buildHomeSnapshot(seed(), { now: NOW });
    expect(s.running.map((r) => r.runId)).toEqual(['run-run']);
    expect(s.system.activeRunCount).toBe(2); // running + waiting_approval
  });

  test('recent-failure window: only failures within 24h count', () => {
    const s = buildHomeSnapshot(seed(), { now: NOW });
    expect(s.attention.map((a) => a.runId)).toEqual(['run-failnew']);
    expect(s.system.recentFailureCount).toBe(1);
    expect(s.firstRun).toBe(false);
  });

  test('recent feed is bounded (≤5) and non-empty', () => {
    const s = buildHomeSnapshot(seed(), { now: NOW });
    expect(s.recent.length).toBeGreaterThan(0);
    expect(s.recent.length).toBeLessThanOrEqual(5);
  });

  test('safety: no context_json / secret ever reaches the snapshot', () => {
    const s = buildHomeSnapshot(seed(), { now: NOW });
    const json = JSON.stringify(s);
    expect(json).not.toContain('DO-NOT-LEAK');
    for (const banned of ['context', 'context_json', 'token', 'apiKey', 'secret', 'password', 'authorization']) {
      for (const item of s.pendingApprovals) expect(item).not.toHaveProperty(banned);
    }
  });
});
