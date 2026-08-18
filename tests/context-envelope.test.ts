/**
 * IGRIS Context Envelope (U1). It records ONLY what the user is looking at
 * (identifiers + small flags), never graphs/prompts/outputs/secrets, and never
 * executes anything. These tests pin the transition logic + the store, and the
 * privacy boundary (allowed keys only).
 */
import { afterEach, describe, expect, test } from 'vitest';
import {
  defaultEnvelope,
  surfaceForRoute,
  applyRoute,
  applyFlow,
  clearFlow,
  applyAgent,
  applyApproval,
  clearApproval,
  ENVELOPE_KEYS,
  getIgrisContext,
  publishRoute,
  publishFlowContext,
  clearFlowContext,
  publishAgentContext,
  publishApprovalContext,
  clearApprovalContext,
  __resetIgrisContextForTests,
  type IgrisContextEnvelope,
} from '@/lib/context-envelope';

afterEach(() => __resetIgrisContextForTests());

const T = 1000;

describe('default + surface mapping', () => {
  test('default context is home with no entity ids', () => {
    expect(defaultEnvelope()).toEqual({ route: '/', surface: 'home', updatedAt: 0 });
  });

  test('surfaceForRoute maps known routes and falls back to other', () => {
    expect(surfaceForRoute('/')).toBe('home');
    expect(surfaceForRoute('/flows')).toBe('flows');
    expect(surfaceForRoute('/flows/anything')).toBe('flows');
    expect(surfaceForRoute('/agents')).toBe('agents');
    expect(surfaceForRoute('/approvals')).toBe('approvals');
    expect(surfaceForRoute('/brain')).toBe('brain');
    expect(surfaceForRoute('/models')).toBe('models');
    expect(surfaceForRoute('/settings')).toBe('settings');
    expect(surfaceForRoute('/roadmap')).toBe('other');
  });
});

describe('route / surface transitions', () => {
  test('route update sets route + surface', () => {
    const next = applyRoute(defaultEnvelope(), '/flows', T);
    expect(next).toMatchObject({ route: '/flows', surface: 'flows', updatedAt: T });
  });

  test('same-surface navigation keeps selection', () => {
    const withSel = applyFlow(applyRoute(defaultEnvelope(), '/flows', T), { workflowId: 'wf1', selectedNodeId: 'n1' }, T);
    const next = applyRoute(withSel, '/flows', T + 1);
    expect(next.workflowId).toBe('wf1');
    expect(next.selectedNodeId).toBe('n1');
  });

  test('navigating AWAY clears flow-specific context', () => {
    const onFlows = applyFlow(applyRoute(defaultEnvelope(), '/flows', T), { workflowId: 'wf1', selectedNodeId: 'n1', runId: 'r1' }, T);
    const away = applyRoute(onFlows, '/agents', T + 1);
    expect(away.surface).toBe('agents');
    expect(away.workflowId).toBeUndefined();
    expect(away.selectedNodeId).toBeUndefined();
    expect(away.runId).toBeUndefined();
  });
});

describe('flow selection transitions', () => {
  const onFlows = () => applyRoute(defaultEnvelope(), '/flows', T);

  test('workflow selection', () => {
    const next = applyFlow(onFlows(), { workflowId: 'wf1', workflowVersion: 2, workflowDraft: true }, T);
    expect(next).toMatchObject({ workflowId: 'wf1', workflowVersion: 2, workflowDraft: true });
  });

  test('node selection', () => {
    const next = applyFlow(applyFlow(onFlows(), { workflowId: 'wf1' }, T), { selectedNodeId: 'n1' }, T);
    expect(next.selectedNodeId).toBe('n1');
  });

  test('edge selection', () => {
    const next = applyFlow(applyFlow(onFlows(), { workflowId: 'wf1' }, T), { selectedEdgeId: 'e1' }, T);
    expect(next.selectedEdgeId).toBe('e1');
  });

  test('run selection', () => {
    const next = applyFlow(applyFlow(onFlows(), { workflowId: 'wf1' }, T), { runId: 'run-9' }, T);
    expect(next.runId).toBe('run-9');
  });

  test('changing workflow clears stale node/edge/run', () => {
    const withSel = applyFlow(onFlows(), { workflowId: 'wf1', selectedNodeId: 'n1', selectedEdgeId: 'e1', runId: 'r1' }, T);
    const switched = applyFlow(withSel, { workflowId: 'wf2' }, T + 1);
    expect(switched.workflowId).toBe('wf2');
    expect(switched.selectedNodeId).toBeUndefined();
    expect(switched.selectedEdgeId).toBeUndefined();
    expect(switched.runId).toBeUndefined();
  });

  test('clearFlow drops all flow context but keeps route/surface', () => {
    const withSel = applyFlow(onFlows(), { workflowId: 'wf1', selectedNodeId: 'n1' }, T);
    const cleared = clearFlow(withSel, T + 1);
    expect(cleared).toEqual({ route: '/flows', surface: 'flows', updatedAt: T + 1 });
  });
});

describe('agent / approval transitions', () => {
  test('applyAgent sets agentId', () => {
    expect(applyAgent(applyRoute(defaultEnvelope(), '/agents', T), 'a1', T).agentId).toBe('a1');
  });
  test('applyApproval sets approvalId (+ optional runId)', () => {
    const next = applyApproval(applyRoute(defaultEnvelope(), '/approvals', T), { approvalId: 'ap1', runId: 'r1' }, T);
    expect(next).toMatchObject({ approvalId: 'ap1', runId: 'r1' });
  });

  test('applyApproval publishes approvalId + runId + workflowId (identifiers only)', () => {
    const next = applyApproval(applyRoute(defaultEnvelope(), '/approvals', T), { approvalId: 'ap1', runId: 'r1', workflowId: 'wf1' }, T);
    expect(next).toMatchObject({ approvalId: 'ap1', runId: 'r1', workflowId: 'wf1' });
  });

  test('applyApproval merges by presence (absent keys are left unchanged)', () => {
    const withAll = applyApproval(applyRoute(defaultEnvelope(), '/approvals', T), { approvalId: 'ap1', runId: 'r1', workflowId: 'wf1' }, T);
    const next = applyApproval(withAll, { approvalId: 'ap2' }, T + 1);
    expect(next.approvalId).toBe('ap2');
    expect(next.runId).toBe('r1'); // untouched
    expect(next.workflowId).toBe('wf1'); // untouched
  });

  test('clearApproval drops approval-selection context but keeps route/surface', () => {
    const withAll = applyApproval(applyRoute(defaultEnvelope(), '/approvals', T), { approvalId: 'ap1', runId: 'r1', workflowId: 'wf1' }, T);
    const cleared = clearApproval(withAll, T + 1);
    expect(cleared.approvalId).toBeUndefined();
    expect(cleared.runId).toBeUndefined();
    expect(cleared.workflowId).toBeUndefined();
    expect(cleared.surface).toBe('approvals');
  });
});

describe('privacy boundary', () => {
  test('envelope only ever contains allowed identifier/flag keys — no payloads', () => {
    const env = applyFlow(applyRoute(defaultEnvelope(), '/flows', T), { workflowId: 'wf1', selectedNodeId: 'n1', runId: 'r1' }, T);
    for (const key of Object.keys(env)) {
      expect(ENVELOPE_KEYS).toContain(key as (typeof ENVELOPE_KEYS)[number]);
    }
    // no graph / prompt / output / secret style fields
    for (const banned of ['graph', 'nodes', 'edges', 'config', 'prompt', 'output', 'token', 'apiKey', 'secret', 'context_json']) {
      expect(env).not.toHaveProperty(banned);
    }
  });
});

describe('immutability', () => {
  test('transitions never mutate the supplied envelope or patch', () => {
    const prev: IgrisContextEnvelope = Object.freeze(applyFlow(applyRoute(defaultEnvelope(), '/flows', T), { workflowId: 'wf1', selectedNodeId: 'n1' }, T));
    const patch = Object.freeze({ workflowId: 'wf2' });
    // Frozen inputs would throw on mutation — these must not.
    expect(() => applyFlow(prev, patch, T + 1)).not.toThrow();
    expect(() => applyRoute(prev, '/agents', T + 1)).not.toThrow();
    expect(() => clearFlow(prev, T + 1)).not.toThrow();
    // originals unchanged
    expect(prev.workflowId).toBe('wf1');
    expect(prev.selectedNodeId).toBe('n1');
    expect(patch).toEqual({ workflowId: 'wf2' });
  });
});

describe('store publishing', () => {
  test('publishRoute + publishFlowContext + clearFlowContext drive the singleton', () => {
    publishRoute('/flows');
    expect(getIgrisContext()).toMatchObject({ route: '/flows', surface: 'flows' });

    publishFlowContext({ workflowId: 'wf1', selectedNodeId: 'n1' });
    expect(getIgrisContext()).toMatchObject({ workflowId: 'wf1', selectedNodeId: 'n1' });

    clearFlowContext();
    expect(getIgrisContext().workflowId).toBeUndefined();
    expect(getIgrisContext().surface).toBe('flows');

    // leaving /flows drops any lingering entity ids
    publishFlowContext({ workflowId: 'wf9', selectedNodeId: 'n9' });
    publishRoute('/models');
    expect(getIgrisContext()).toMatchObject({ surface: 'models' });
    expect(getIgrisContext().workflowId).toBeUndefined();
    expect(getIgrisContext().selectedNodeId).toBeUndefined();
  });

  test('agent selection publishes agentId; navigation clears it', () => {
    publishRoute('/agents');
    publishAgentContext('agent-1');
    expect(getIgrisContext().agentId).toBe('agent-1');

    publishRoute('/models'); // surface change drops the stale agent id
    expect(getIgrisContext().agentId).toBeUndefined();
  });

  test('approval selection publishes approvalId/runId/workflowId; clear + navigation drop them', () => {
    publishRoute('/approvals');
    publishApprovalContext({ approvalId: 'ap1', runId: 'r1', workflowId: 'wf1' });
    expect(getIgrisContext()).toMatchObject({ approvalId: 'ap1', runId: 'r1', workflowId: 'wf1' });

    clearApprovalContext();
    expect(getIgrisContext().approvalId).toBeUndefined();
    expect(getIgrisContext().runId).toBeUndefined();
    expect(getIgrisContext().workflowId).toBeUndefined();
    expect(getIgrisContext().surface).toBe('approvals');

    // re-select then navigate away — nothing lingers
    publishApprovalContext({ approvalId: 'ap2', runId: 'r2', workflowId: 'wf2' });
    publishRoute('/brain');
    expect(getIgrisContext().approvalId).toBeUndefined();
    expect(getIgrisContext().runId).toBeUndefined();
    expect(getIgrisContext().workflowId).toBeUndefined();
  });

  test('published envelope stays identifiers-only after agent/approval publishing', () => {
    publishRoute('/approvals');
    publishApprovalContext({ approvalId: 'ap1', runId: 'r1', workflowId: 'wf1' });
    for (const key of Object.keys(getIgrisContext())) {
      expect(ENVELOPE_KEYS).toContain(key as (typeof ENVELOPE_KEYS)[number]);
    }
  });
});
