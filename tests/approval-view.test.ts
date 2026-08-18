/**
 * UX Foundation U5, Part A — Approval Decision Card pure model.
 *
 * Pins the safe view projection (no context_json / no secrets), the approve/reject
 * route labels + effects, the resolved→actions-disabled flag, the conservative
 * risk heuristic (request-type floor × downstream effect, never under-claimed),
 * and the version-graph downstream classifier.
 */
import { describe, expect, test } from 'vitest';
import {
  approvalRisk,
  buildApprovalDecisionView,
  classifyDownstream,
  type ApprovalViewInput,
} from '@/lib/flows/approval-view';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';

const base = (over: Partial<ApprovalViewInput> = {}): ApprovalViewInput => ({
  id: 'appr-1',
  status: 'pending',
  requestType: 'workflow',
  title: 'Send it?',
  message: 'Send the drafted email reply',
  workflowId: 'wf',
  workflowVersion: 1,
  runId: 'run-128',
  nodeId: 'ap',
  nodeRunId: 'nr-1',
  approvalRoute: 'approve',
  rejectionRoute: 'reject',
  requestedAt: '2026-08-13T10:00:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  ...over,
});

describe('buildApprovalDecisionView', () => {
  test('pending view: fields, route labels + effects, not resolved', () => {
    const v = buildApprovalDecisionView(base(), { workflowName: 'Gmail Daily', downstream: 'internal' });
    expect(v).toMatchObject({
      approvalId: 'appr-1',
      status: 'pending',
      resolved: false,
      title: 'Send it?',
      message: 'Send the drafted email reply',
      workflowName: 'Gmail Daily',
      runId: 'run-128',
      approveRoute: 'approve',
      rejectRoute: 'reject',
      approveEffect: 'Continue via "approve" route',
      rejectEffect: 'Continue via "reject" route',
    });
  });

  test('approved view is resolved (actions disabled) and carries resolution detail', () => {
    const v = buildApprovalDecisionView(
      base({ status: 'approved', resolvedAt: '2026-08-13T10:05:00.000Z', resolvedBy: 'local_operator', resolutionNote: 'go' }),
      { downstream: 'internal' },
    );
    expect(v.resolved).toBe(true);
    expect(v.status).toBe('approved');
    expect(v.resolvedBy).toBe('local_operator');
    expect(v.resolutionNote).toBe('go');
  });

  test('rejected view is resolved', () => {
    const v = buildApprovalDecisionView(base({ status: 'rejected', resolvedAt: '2026-08-13T10:05:00.000Z' }), { downstream: 'internal' });
    expect(v.resolved).toBe(true);
    expect(v.status).toBe('rejected');
  });

  test('never exposes raw context_json or any secret-looking field', () => {
    const v = buildApprovalDecisionView(base(), { downstream: 'external' });
    for (const banned of ['context', 'context_json', 'token', 'apiKey', 'secret', 'authorization', 'password']) {
      expect(v).not.toHaveProperty(banned);
    }
    // Only the documented safe keys exist.
    const allowed = new Set([
      'approvalId', 'status', 'resolved', 'requestType', 'title', 'message', 'workflowId', 'workflowVersion',
      'workflowName', 'runId', 'nodeId', 'nodeRunId', 'approveRoute', 'rejectRoute', 'approveEffect',
      'rejectEffect', 'risk', 'riskReason', 'requestedAt', 'resolvedAt', 'resolvedBy', 'resolutionNote',
    ]);
    for (const key of Object.keys(v)) expect(allowed.has(key)).toBe(true);
  });

  test('empty message collapses to undefined (no blank field)', () => {
    const v = buildApprovalDecisionView(base({ message: '   ' }), { downstream: 'internal' });
    expect(v.message).toBeUndefined();
  });
});

describe('approvalRisk heuristic (conservative, never under-claimed)', () => {
  test('workflow + internal continuation → low', () => {
    expect(approvalRisk('workflow', 'internal').risk).toBe('low');
  });
  test('workflow + downstream agent → medium', () => {
    expect(approvalRisk('workflow', 'agent').risk).toBe('medium');
  });
  test('workflow + external downstream → high', () => {
    const r = approvalRisk('workflow', 'external');
    expect(r.risk).toBe('high');
    expect(r.reason).toMatch(/external/);
  });
  test('unknown downstream is medium, never a guessed low', () => {
    expect(approvalRisk('workflow', 'unknown').risk).toBe('medium');
  });
  test('request-type floor raises risk above an otherwise-low downstream', () => {
    // sudo/secret/tool floor at high even when downstream looks internal.
    expect(approvalRisk('sudo', 'internal').risk).toBe('high');
    expect(approvalRisk('secret', 'internal').risk).toBe('high');
    expect(approvalRisk('tool', 'internal').risk).toBe('high');
    // hermes floors at medium.
    expect(approvalRisk('hermes', 'internal').risk).toBe('medium');
  });
});

// ── Downstream classification over the immutable version graph ────────────────

const G = (nodes: unknown[], edges: unknown[]): WorkflowGraph => WorkflowGraphSchema.parse({ nodes, edges });
const input = (id: string) => ({ id, type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } });
const agent = (id: string, agentId = 'a1') => ({ id, type: 'agent', x: 0, y: 0, config: { agentId } });
const approval = (id: string) => ({ id, type: 'approval', x: 0, y: 0, config: { title: 't', message: '', approveRoute: 'approve', rejectRoute: 'reject' } });
const tool = (id: string) => ({ id, type: 'tool', x: 0, y: 0, config: { toolSlug: 'slack' } });
const output = (id: string, mode = 'display') => ({ id, type: 'output', x: 0, y: 0, config: { mode } });
const edge = (id: string, s: string, t: string, extra: Record<string, unknown> = {}) => ({ id, source: s, target: t, ...extra });

describe('classifyDownstream', () => {
  test('approve → display output only → internal', () => {
    const g = G([approval('ap'), output('ok')], [edge('e', 'ap', 'ok', { sourceHandle: 'approve' })]);
    expect(classifyDownstream(g, 'ap', 'approve')).toBe('internal');
  });
  test('approve → external notify output → external', () => {
    const g = G([approval('ap'), output('ok', 'notify')], [edge('e', 'ap', 'ok', { sourceHandle: 'approve' })]);
    expect(classifyDownstream(g, 'ap', 'approve')).toBe('external');
  });
  test('approve → tool node → external', () => {
    const g = G([approval('ap'), tool('t'), output('ok')], [edge('e1', 'ap', 't', { sourceHandle: 'approve' }), edge('e2', 't', 'ok')]);
    expect(classifyDownstream(g, 'ap', 'approve')).toBe('external');
  });
  test('approve → agent node → agent', () => {
    const g = G([approval('ap'), agent('a2'), output('ok')], [edge('e1', 'ap', 'a2', { sourceHandle: 'approve' }), edge('e2', 'a2', 'ok')]);
    expect(classifyDownstream(g, 'ap', 'approve')).toBe('agent');
  });
  test('only the reject branch is external → approve route classifies internal', () => {
    const g = G(
      [approval('ap'), output('ok'), output('sent', 'notify')],
      [edge('e1', 'ap', 'ok', { sourceHandle: 'approve' }), edge('e2', 'ap', 'sent', { sourceHandle: 'reject' })],
    );
    expect(classifyDownstream(g, 'ap', 'approve')).toBe('internal');
  });
  test('missing graph → unknown (never guessed internal)', () => {
    expect(classifyDownstream(null, 'ap', 'approve')).toBe('unknown');
  });
});
