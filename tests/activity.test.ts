/**
 * IGRIS Activity / Ops Stream (U4) — a READ-ONLY projection over authoritative
 * run/approval/node-run state. Tests cover: normalization of each source,
 * newest-first + deterministic tie ordering, limit enforcement, category
 * filters, navigation mapping, the poll-overlap guard, hydration-safe default,
 * and — critically — that NO secret/payload ever reaches an ActivityEvent.
 */
import { describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import {
  eventsForRun,
  eventsForApproval,
  eventsForNodeRun,
  sortEvents,
  filterEvents,
  buildFeed,
  navHrefForEvent,
  isNeedsAttention,
  canStartPoll,
  ACTIVITY_MAX_LIMIT,
  type ActivityEvent,
  type RunLite,
  type ApprovalLite,
  type NodeRunLite,
} from '@/lib/activity/model';
import { buildActivityFeed } from '@/lib/activity/service';
import { parseBoolPref } from '@/lib/layout-prefs';
import type { WorkflowGraph } from '@/lib/flows/schema';

const run = (patch: Partial<RunLite> = {}): RunLite => ({
  id: 'r1', workflowId: 'wf-1', workflowName: 'Gmail Daily', status: 'success',
  startedAt: '2026-08-12T09:32:00.000Z', endedAt: '2026-08-12T09:36:00.000Z',
  createdAt: '2026-08-12T09:32:00.000Z', updatedAt: '2026-08-12T09:36:00.000Z',
  errorCode: null, errorMessage: null, ...patch,
});

// ── Run normalization ────────────────────────────────────────────────────────

describe('run normalization', () => {
  test('a success run → started + completed (workflow category)', () => {
    const evts = eventsForRun(run());
    expect(evts.map((e) => e.kind)).toEqual(['run_started', 'run_completed']);
    expect(evts.every((e) => e.category === 'workflow')).toBe(true);
    expect(evts[1].title).toBe('Gmail Daily completed');
  });

  test('a failed run → started (workflow) + failed (ERROR category, message as detail)', () => {
    const evts = eventsForRun(run({ status: 'failed', errorMessage: 'provider timeout' }));
    const failed = evts.find((e) => e.kind === 'run_failed')!;
    expect(failed.category).toBe('error');
    expect(failed.detail).toBe('provider timeout');
  });

  test('waiting_approval run → run_waiting_approval (needs attention)', () => {
    const evts = eventsForRun(run({ status: 'waiting_approval', endedAt: null }));
    const waiting = evts.find((e) => e.kind === 'run_waiting_approval')!;
    expect(waiting.category).toBe('workflow');
    expect(isNeedsAttention(waiting)).toBe(true);
  });

  test('a running/queued run → only a started event (no fabricated terminal state)', () => {
    expect(eventsForRun(run({ status: 'running', endedAt: null })).map((e) => e.kind)).toEqual(['run_started']);
    expect(eventsForRun(run({ status: 'queued', startedAt: null, endedAt: null })).map((e) => e.kind)).toEqual(['run_started']);
  });

  test('falls back to createdAt / updatedAt when start/end are missing', () => {
    const evts = eventsForRun(run({ status: 'queued', startedAt: null, endedAt: null, createdAt: '2026-08-12T09:00:00.000Z' }));
    expect(evts[0].timestamp).toBe('2026-08-12T09:00:00.000Z');
  });
});

// ── Approval normalization ───────────────────────────────────────────────────

const approval = (patch: Partial<ApprovalLite> = {}): ApprovalLite => ({
  id: 'ap1', runId: 'r1', workflowId: 'wf-1', workflowName: 'Gmail Daily', status: 'pending',
  title: 'Send invoice?', requestedAt: '2026-08-12T09:34:00.000Z', resolvedAt: null, ...patch,
});

describe('approval normalization', () => {
  test('pending → a single "approval required" event (needs attention)', () => {
    const evts = eventsForApproval(approval());
    expect(evts).toHaveLength(1);
    expect(evts[0].category).toBe('approval');
    expect(evts[0].kind).toBe('approval_requested');
    expect(isNeedsAttention(evts[0])).toBe(true);
  });

  test('resolved → requested + approved/rejected event', () => {
    const evts = eventsForApproval(approval({ status: 'approved', resolvedAt: '2026-08-12T09:35:00.000Z' }));
    expect(evts.map((e) => e.kind)).toEqual(['approval_requested', 'approval_approved']);
    expect(evts[1].timestamp).toBe('2026-08-12T09:35:00.000Z');
  });
});

// ── Node normalization (agent + failures only; no flooding) ──────────────────

const nodeRun = (patch: Partial<NodeRunLite> = {}): NodeRunLite => ({
  id: 'nr1', runId: 'r1', workflowId: 'wf-1', workflowName: 'Gmail Daily', nodeId: 'n1', nodeType: 'agent',
  status: 'success', agentId: 'gmail', agentName: 'Gmail Worker',
  startedAt: '2026-08-12T09:33:00.000Z', endedAt: '2026-08-12T09:33:30.000Z', createdAt: '2026-08-12T09:33:00.000Z', errorMessage: null, ...patch,
});

describe('node normalization', () => {
  test('agent success → agent event with the resolved agent name', () => {
    const evts = eventsForNodeRun(nodeRun());
    expect(evts).toHaveLength(1);
    expect(evts[0]).toMatchObject({ category: 'agent', kind: 'agent_completed', agentId: 'gmail' });
    expect(evts[0].title).toBe('Gmail Worker completed');
  });

  test('agent failure → ERROR category', () => {
    expect(eventsForNodeRun(nodeRun({ status: 'failed', errorMessage: 'auth expired' }))[0]).toMatchObject({ category: 'error', kind: 'agent_failed' });
  });

  test('agent node WITHOUT a resolved agentId is NOT shown as an agent (no guessing)', () => {
    expect(eventsForNodeRun(nodeRun({ agentId: undefined, agentName: undefined, status: 'success' }))).toEqual([]);
  });

  test('non-agent node: only failures surface (as node errors); success is dropped', () => {
    expect(eventsForNodeRun(nodeRun({ nodeType: 'transform', agentId: undefined, status: 'success' }))).toEqual([]);
    const failed = eventsForNodeRun(nodeRun({ nodeType: 'transform', agentId: undefined, status: 'failed', errorMessage: 'bad map' }));
    expect(failed[0]).toMatchObject({ category: 'error', kind: 'node_failed' });
  });
});

// ── Ordering / filter / limit ────────────────────────────────────────────────

describe('ordering + filters + limit', () => {
  const evts: ActivityEvent[] = [
    { id: 'a', timestamp: '2026-08-12T09:30:00.000Z', category: 'workflow', kind: 'run_started', title: 'A' },
    { id: 'b', timestamp: '2026-08-12T09:36:00.000Z', category: 'error', kind: 'run_failed', title: 'B' },
    { id: 'z', timestamp: '2026-08-12T09:36:00.000Z', category: 'agent', kind: 'agent_completed', title: 'Z' },
  ];

  test('newest first', () => {
    expect(sortEvents(evts).map((e) => e.id)).toEqual(['z', 'b', 'a']); // equal ts → id DESC tiebreak
  });

  test('deterministic tie ordering (equal timestamps never reorder)', () => {
    expect(sortEvents(evts).map((e) => e.id)).toEqual(sortEvents([...evts].reverse()).map((e) => e.id));
  });

  test('category filters', () => {
    expect(filterEvents(evts, 'errors').map((e) => e.id)).toEqual(['b']);
    expect(filterEvents(evts, 'agents').map((e) => e.id)).toEqual(['z']);
    expect(filterEvents(evts, 'flows').map((e) => e.id)).toEqual(['a']);
    expect(filterEvents(evts, 'all')).toHaveLength(3);
  });

  test('buildFeed sorts, filters, and enforces the limit + hard cap', () => {
    expect(buildFeed(evts, { limit: 2 }).map((e) => e.id)).toEqual(['z', 'b']);
    const many = Array.from({ length: 500 }, (_, i) => ({ ...evts[0], id: `e${i}` }));
    expect(buildFeed(many, { limit: 9999 }).length).toBe(ACTIVITY_MAX_LIMIT);
  });
});

// ── Navigation mapping ───────────────────────────────────────────────────────

describe('navigation mapping', () => {
  test('workflow/error → /flows, approval → /approvals, agent → /agents', () => {
    expect(navHrefForEvent({ id: '1', timestamp: 't', category: 'workflow', kind: 'k', title: 'x', workflowId: 'wf' })).toBe('/flows');
    expect(navHrefForEvent({ id: '2', timestamp: 't', category: 'error', kind: 'k', title: 'x', workflowId: 'wf' })).toBe('/flows');
    expect(navHrefForEvent({ id: '3', timestamp: 't', category: 'approval', kind: 'k', title: 'x' })).toBe('/approvals');
    expect(navHrefForEvent({ id: '4', timestamp: 't', category: 'agent', kind: 'k', title: 'x' })).toBe('/agents');
  });
});

// ── Poll overlap + hydration default ─────────────────────────────────────────

describe('poll guard + hydration-safe default', () => {
  test('canStartPoll only when open, mounted, and not in flight', () => {
    expect(canStartPoll({ open: true, mounted: true, inFlight: false })).toBe(true);
    expect(canStartPoll({ open: true, mounted: true, inFlight: true })).toBe(false); // no overlap
    expect(canStartPoll({ open: false, mounted: true, inFlight: false })).toBe(false);
    expect(canStartPoll({ open: true, mounted: false, inFlight: false })).toBe(false);
  });

  test('dock defaults to COLLAPSED when no preference is stored (deterministic SSR)', () => {
    expect(parseBoolPref(null)).toBe(false);
  });
});

// ── Safety: no secret / payload ever reaches an ActivityEvent ────────────────

describe('safety — no payload/secret leakage', () => {
  test('long error messages are truncated (a blob can never balloon the stream)', () => {
    const big = 'x'.repeat(1000);
    const failed = eventsForRun(run({ status: 'failed', errorMessage: big })).find((e) => e.kind === 'run_failed')!;
    expect(failed.detail!.length).toBeLessThanOrEqual(160);
  });

  test('an ActivityEvent never carries payload/secret keys', () => {
    const all = [...eventsForRun(run()), ...eventsForApproval(approval()), ...eventsForNodeRun(nodeRun())];
    const banned = ['output', 'input', 'context', 'contextjson', 'prompt', 'token', 'secret', 'apikey', 'authorization', 'startinginput', 'body'];
    for (const e of all) {
      for (const k of Object.keys(e)) expect(banned).not.toContain(k.toLowerCase());
    }
  });
});

// ── Service: end-to-end over the real repositories (in-memory) ───────────────

const graph: WorkflowGraph = {
  nodes: [
    { id: 'in', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
    { id: 'out', type: 'output', x: 100, y: 0, config: { mode: 'display' } },
  ],
  edges: [{ id: 'e1', source: 'in', target: 'out', mapping: { mode: 'all' } }],
};

describe('buildActivityFeed (service, in-memory db)', () => {
  test('projects runs/approvals/failures into a bounded feed — with NO secret leakage', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf-1', name: 'Gmail Daily', graph });

    const ok = db.flowRuns.create({ id: 'run-ok', workflowId: 'wf-1', workflowVersion: 1, startingInput: { text: 'SECRET_INPUT_ABC' } });
    db.flowRuns.update(ok.id, { status: 'success', startedAt: '2026-08-12T09:00:00.000Z', endedAt: '2026-08-12T09:01:00.000Z' });

    const bad = db.flowRuns.create({ id: 'run-bad', workflowId: 'wf-1', workflowVersion: 1, startingInput: { text: '' } });
    db.flowRuns.update(bad.id, { status: 'failed', errorMessage: 'boom', startedAt: '2026-08-12T09:02:00.000Z', endedAt: '2026-08-12T09:03:00.000Z' });
    const nr = db.flowNodeRuns.create({ id: 'nr-bad', runId: bad.id, nodeId: 'x', nodeType: 'transform', status: 'failed' });
    db.flowNodeRuns.update(nr.id, { output: { data: { leaked: 'SECRET_OUTPUT_XYZ' } }, errorMessage: 'transform failed' });

    const waiting = db.flowRuns.create({ id: 'run-wait', workflowId: 'wf-1', workflowVersion: 1, startingInput: { text: '' } });
    db.flowRuns.update(waiting.id, { status: 'waiting_approval' });
    db.flowApprovals.create({
      id: 'ap-1', runId: waiting.id, nodeRunId: null, workflowId: 'wf-1', workflowVersion: 1, nodeId: 'gate',
      title: 'Approve send?', message: 'ok?', context: { apiKey: 'SECRET_KEY_123' }, approvalRoute: 'approved', rejectionRoute: 'rejected',
    });

    const feed = buildActivityFeed(db, { limit: 50 });

    const kinds = feed.map((e) => e.kind);
    expect(kinds).toContain('run_completed');
    expect(kinds).toContain('run_failed');
    expect(kinds).toContain('run_waiting_approval');
    expect(kinds).toContain('approval_requested');
    expect(kinds).toContain('node_failed');
    // failed run + failed node are ERROR category
    expect(feed.filter((e) => e.category === 'error').length).toBeGreaterThanOrEqual(2);

    // Nothing from starting_input / node output / approval context ever surfaces.
    const serialized = JSON.stringify(feed);
    for (const secret of ['SECRET_INPUT_ABC', 'SECRET_OUTPUT_XYZ', 'SECRET_KEY_123']) {
      expect(serialized).not.toContain(secret);
    }
  });

  test('respects the limit', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf-1', name: 'WF', graph });
    for (let i = 0; i < 20; i++) {
      const r = db.flowRuns.create({ id: `run-${i}`, workflowId: 'wf-1', workflowVersion: 1, startingInput: { text: '' } });
      db.flowRuns.update(r.id, { status: 'success', startedAt: '2026-08-12T09:00:00.000Z', endedAt: '2026-08-12T09:01:00.000Z' });
    }
    expect(buildActivityFeed(db, { limit: 5 }).length).toBe(5);
  });
});
