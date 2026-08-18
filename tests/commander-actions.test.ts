/**
 * IGRIS Commander action registry (U3) — the Plan → Preview → Execute safety
 * funnel. All pure: recognition never executes; typed actions require context;
 * previews come from authoritative data (never raw text); routes are a fixed map
 * (no arbitrary URL/SQL/shell); risk is never under-claimed; no secrets leak.
 */
import { describe, expect, test } from 'vitest';
import {
  recognizeCommanderAction,
  isCommanderActionType,
  previewPlan,
  executePlan,
  buildRunPreview,
  buildPublishPreview,
  buildDeletePreview,
  buildApprovalPreview,
  buildHermesPreview,
  formatResult,
  COMMANDER_ACTION_TYPES,
  actionSpec,
  type CommanderAction,
  type WorkflowPreviewData,
} from '@/lib/commander-actions';
import type { IgrisContextEnvelope } from '@/lib/context-envelope';

const env = (patch: Partial<IgrisContextEnvelope> = {}): IgrisContextEnvelope => ({
  route: '/', surface: 'home', updatedAt: 1, ...patch,
});

const wfData = (patch: Partial<WorkflowPreviewData['workflow']> = {}, rest: Partial<WorkflowPreviewData> = {}): WorkflowPreviewData => ({
  workflow: { id: 'wf-1', name: 'Gmail Daily', currentVersion: 3, ...patch },
  versions: [{ version: 3, createdAt: '2026-08-01T00:00:00Z' }],
  ...rest,
});

// ── Recognition (typed proposal, context-grounded, inert) ────────────────────

describe('recognition — typed proposals', () => {
  const flows = env({ surface: 'flows', workflowId: 'wf-1' });

  test('run this workflow → run_workflow with the context id', () => {
    const r = recognizeCommanderAction('run this workflow', flows);
    expect(r).toEqual({ kind: 'action', action: { type: 'run_workflow', workflowId: 'wf-1' }, risk: 'medium', title: 'Run workflow' });
  });

  test('publish this workflow → publish_workflow', () => {
    expect(recognizeCommanderAction('publish this workflow', flows)).toMatchObject({ kind: 'action', action: { type: 'publish_workflow', workflowId: 'wf-1' } });
  });

  test('delete / archive this workflow → delete_workflow (high risk)', () => {
    expect(recognizeCommanderAction('delete this workflow', flows)).toMatchObject({ kind: 'action', action: { type: 'delete_workflow' }, risk: 'high' });
    expect(recognizeCommanderAction('archive this workflow', flows)).toMatchObject({ kind: 'action', action: { type: 'delete_workflow' } });
  });

  test('Hermes transport switch → set_hermes_transport (no context needed)', () => {
    expect(recognizeCommanderAction('use Hermes Serve', env())).toMatchObject({ kind: 'action', action: { type: 'set_hermes_transport', transport: 'serve' } });
    expect(recognizeCommanderAction('switch Hermes to ACP', env())).toMatchObject({ kind: 'action', action: { type: 'set_hermes_transport', transport: 'acp' } });
    expect(recognizeCommanderAction('use ACP', env())).toMatchObject({ kind: 'action', action: { type: 'set_hermes_transport', transport: 'acp' } });
  });

  test('approve / reject with approval context → resolve_approval (high risk)', () => {
    const ap = env({ surface: 'approvals', approvalId: 'ap-9' });
    expect(recognizeCommanderAction('approve this', ap)).toEqual({ kind: 'action', action: { type: 'resolve_approval', approvalId: 'ap-9', decision: 'approve' }, risk: 'high', title: 'Resolve approval' });
    expect(recognizeCommanderAction('reject this', ap)).toMatchObject({ kind: 'action', action: { decision: 'reject' } });
  });
});

describe('recognition — honest missing context (no guessing)', () => {
  test('workflow action without a selected workflow → missing', () => {
    const r = recognizeCommanderAction('run this workflow', env({ surface: 'flows' }));
    expect(r).toEqual({ kind: 'missing', type: 'run_workflow', title: 'Run workflow', missing: ['a workflow'] });
  });

  test('approve without a selected approval → missing (never a guessed id)', () => {
    const r = recognizeCommanderAction('approve this', env({ surface: 'approvals' }));
    expect(r).toEqual({ kind: 'missing', type: 'resolve_approval', title: 'Resolve approval', missing: ['an approval'] });
  });

  test('non-action text → unknown', () => {
    expect(recognizeCommanderAction('why did this fail', env())).toEqual({ kind: 'unknown' });
    expect(recognizeCommanderAction('', env())).toEqual({ kind: 'unknown' });
  });
});

// ── Registry / type allow-list ───────────────────────────────────────────────

describe('typed registry is a closed allow-list', () => {
  test('isCommanderActionType rejects anything not registered (LLM boundary)', () => {
    for (const t of COMMANDER_ACTION_TYPES) expect(isCommanderActionType(t)).toBe(true);
    for (const bad of ['exec', 'run_shell', 'delete_all', '', 42, null, { type: 'run_workflow' }]) expect(isCommanderActionType(bad)).toBe(false);
  });

  test('every action type has a spec with a defined risk', () => {
    for (const t of COMMANDER_ACTION_TYPES) expect(['low', 'medium', 'high']).toContain(actionSpec(t).risk);
  });
});

// ── Route plans (fixed map to existing endpoints; no arbitrary URLs) ──────────

describe('route plans map typed actions to existing APIs only', () => {
  test('executePlan produces the exact existing mutation route + method', () => {
    expect(executePlan({ type: 'run_workflow', workflowId: 'wf-1' })).toEqual({ method: 'POST', path: '/api/flows/wf-1/runs', body: {} });
    expect(executePlan({ type: 'publish_workflow', workflowId: 'wf-1' })).toEqual({ method: 'POST', path: '/api/flows/wf-1/versions', body: {} });
    expect(executePlan({ type: 'delete_workflow', workflowId: 'wf-1' })).toEqual({ method: 'DELETE', path: '/api/flows/wf-1' });
    expect(executePlan({ type: 'resolve_approval', approvalId: 'ap-9', decision: 'approve' })).toEqual({ method: 'POST', path: '/api/flow-approvals/ap-9/approve', body: {} });
    expect(executePlan({ type: 'resolve_approval', approvalId: 'ap-9', decision: 'reject' })).toMatchObject({ path: '/api/flow-approvals/ap-9/reject' });
    expect(executePlan({ type: 'set_hermes_transport', transport: 'serve' })).toEqual({ method: 'POST', path: '/api/settings/hermes-runtime', body: { action: 'set_transport', transport: 'serve' } });
  });

  test('ids are URL-encoded (no path injection from a crafted id)', () => {
    const evil: CommanderAction = { type: 'delete_workflow', workflowId: '../../etc/passwd' };
    expect(executePlan(evil).path).toBe('/api/flows/..%2F..%2Fetc%2Fpasswd');
    expect(previewPlan(evil).path).toBe('/api/flows/..%2F..%2Fetc%2Fpasswd');
  });

  test('previewPlan is always a GET (no mutation while previewing)', () => {
    for (const a of [
      { type: 'run_workflow', workflowId: 'w' },
      { type: 'publish_workflow', workflowId: 'w' },
      { type: 'delete_workflow', workflowId: 'w' },
      { type: 'resolve_approval', approvalId: 'a', decision: 'approve' },
      { type: 'set_hermes_transport', transport: 'serve' },
    ] as CommanderAction[]) {
      expect(previewPlan(a).method).toBe('GET');
    }
  });
});

// ── Preview builders (authoritative data → card) ─────────────────────────────

describe('run preview', () => {
  test('shows the published version and keeps approval gates', () => {
    const p = buildRunPreview({ type: 'run_workflow', workflowId: 'wf-1' }, wfData());
    expect(p.blocked).toBe(false);
    expect(p.fields).toContainEqual({ label: 'Published version', value: 'v3' });
    expect(p.effects.join(' ')).toMatch(/Human Approval/i);
  });

  test('unpublished draft edits raise an honest warning (still runs published vN)', () => {
    const data = wfData({ updatedAt: '2026-08-02T00:00:00Z' }); // saved after v3 published
    const p = buildRunPreview({ type: 'run_workflow', workflowId: 'wf-1' }, data);
    expect(p.warnings.join(' ')).toMatch(/unpublished changes/i);
    expect(p.warnings.join(' ')).toMatch(/published v3/);
    expect(p.blocked).toBe(false);
  });

  test('never-published workflow blocks the run', () => {
    const p = buildRunPreview({ type: 'run_workflow', workflowId: 'wf-1' }, wfData({ currentVersion: null }, { versions: [] }));
    expect(p.blocked).toBe(true);
    expect(p.blockedReason).toMatch(/no published version/i);
  });
});

describe('publish preview', () => {
  test('shows next version when the draft validates', () => {
    const p = buildPublishPreview({ type: 'publish_workflow', workflowId: 'wf-1' }, { ...wfData(), draftValidation: { ok: true, issues: [] } });
    expect(p.blocked).toBe(false);
    expect(p.fields).toContainEqual({ label: 'Next version', value: 'v4' });
  });

  test('invalid draft disables confirmation', () => {
    const p = buildPublishPreview({ type: 'publish_workflow', workflowId: 'wf-1' }, { ...wfData(), draftValidation: { ok: false, issues: [{ code: 'empty', message: 'Workflow has no nodes.' }] } });
    expect(p.blocked).toBe(true);
    expect(p.blockedReason).toMatch(/no nodes/i);
  });
});

describe('delete preview', () => {
  test('says ARCHIVE when history (versions) exist — high risk', () => {
    const p = buildDeletePreview({ type: 'delete_workflow', workflowId: 'wf-1' }, wfData());
    expect(p.risk).toBe('high');
    expect(p.fields).toContainEqual({ label: 'Behavior', value: 'Archive (history exists)' });
    expect(p.effects.join(' ')).toMatch(/preserved/i);
  });

  test('says HARD DELETE for a history-free draft', () => {
    const p = buildDeletePreview({ type: 'delete_workflow', workflowId: 'wf-1' }, wfData({ currentVersion: null }, { versions: [] }));
    expect(p.fields).toContainEqual({ label: 'Behavior', value: 'Hard delete (no history)' });
  });
});

describe('approval preview', () => {
  test('shows safe fields only — strips the raw context blob and any secret keys', () => {
    const p = buildApprovalPreview(
      { type: 'resolve_approval', approvalId: 'ap-9', decision: 'approve' },
      { id: 'ap-9', status: 'pending', title: 'Send invoice?', workflowId: 'wf-1', workflowVersion: 3, runId: 'run-7', approvalRoute: 'approved' },
    );
    expect(p.blocked).toBe(false);
    const serialized = JSON.stringify(p).toLowerCase();
    for (const banned of ['token', 'secret', 'apikey', 'authorization', 'password', 'context_json']) {
      expect(serialized).not.toContain(banned);
    }
  });

  test('an already-resolved approval fails honestly BEFORE execution', () => {
    const p = buildApprovalPreview({ type: 'resolve_approval', approvalId: 'ap-9', decision: 'approve' }, { id: 'ap-9', status: 'approved' });
    expect(p.blocked).toBe(true);
    expect(p.blockedReason).toMatch(/already approved/i);
  });
});

describe('hermes transport preview', () => {
  test('serve ineligible disables confirm and surfaces the reasons', () => {
    const p = buildHermesPreview({ type: 'set_hermes_transport', transport: 'serve' }, { productionTransport: 'acp', eligibility: { eligible: false, reasons: ['serve session token is not configured'] } });
    expect(p.blocked).toBe(true);
    expect(p.blockedReason).toMatch(/token is not configured/i);
  });

  test('serve eligible allows the switch', () => {
    const p = buildHermesPreview({ type: 'set_hermes_transport', transport: 'serve' }, { productionTransport: 'acp', eligibility: { eligible: true, reasons: [] } });
    expect(p.blocked).toBe(false);
  });

  test('ACP rollback is always allowed', () => {
    const p = buildHermesPreview({ type: 'set_hermes_transport', transport: 'acp' }, { productionTransport: 'serve', eligibility: { eligible: false, reasons: ['x'] } });
    expect(p.blocked).toBe(false);
  });

  test('switching to the current transport is a no-op (blocked)', () => {
    const p = buildHermesPreview({ type: 'set_hermes_transport', transport: 'acp' }, { productionTransport: 'acp', eligibility: { eligible: true, reasons: [] } });
    expect(p.blocked).toBe(true);
  });
});

// ── Result formatting (honest success + failure, no silent fallback) ─────────

describe('result formatting', () => {
  test('run success surfaces the run id + open link', () => {
    const r = formatResult({ type: 'run_workflow', workflowId: 'wf-1' }, true, { ok: true, runId: 'run-42' });
    expect(r).toMatchObject({ ok: true, headline: 'Workflow started', detail: 'Run run-42' });
    expect(r.openHref).toContain('run-42');
  });

  test('delete surfaces the backend-decided mode', () => {
    expect(formatResult({ type: 'delete_workflow', workflowId: 'wf-1' }, true, { ok: true, mode: 'archived' })).toMatchObject({ ok: true, headline: 'Workflow archived' });
    expect(formatResult({ type: 'delete_workflow', workflowId: 'wf-1' }, true, { ok: true, mode: 'deleted' })).toMatchObject({ headline: 'Workflow deleted' });
  });

  test('already-resolved approval reports no change, not a false success', () => {
    const r = formatResult({ type: 'resolve_approval', approvalId: 'ap-9', decision: 'approve' }, true, { ok: true, alreadyResolved: true });
    expect(r.headline).toMatch(/already resolved/i);
  });

  test('failure is surfaced verbatim with reasons — never a silent fallback', () => {
    const r = formatResult({ type: 'set_hermes_transport', transport: 'serve' }, false, { ok: false, error: 'Serve is not eligible for production yet.', reasons: ['token missing'] });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not eligible/i);
    expect(r.detail).toMatch(/token missing/i);
  });
});
