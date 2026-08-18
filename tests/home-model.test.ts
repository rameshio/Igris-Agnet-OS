/**
 * UX Foundation U6 — Commander Home pure model.
 *
 * Pins the deterministic greeting boundaries, the briefing summary line (incl.
 * the empty/caught-up state), first-run detection, the CHEAP Hermes status
 * classification (never green when unknown), and the canonical nav targets.
 */
import { describe, expect, test } from 'vitest';
import {
  greetingForHour,
  homeSummaryLines,
  isFirstRun,
  homeHermesStatus,
  HOME_TARGETS,
  type HomeApprovalItem,
  type HomeAttentionItem,
  type HomeRunItem,
} from '@/lib/home/model';

describe('greetingForHour (deterministic boundaries)', () => {
  test('late night < 5', () => {
    expect(greetingForHour(0)).toBe('Late night');
    expect(greetingForHour(4)).toBe('Late night');
  });
  test('morning 5–11', () => {
    expect(greetingForHour(5)).toBe('Good morning');
    expect(greetingForHour(11)).toBe('Good morning');
  });
  test('afternoon 12–17', () => {
    expect(greetingForHour(12)).toBe('Good afternoon');
    expect(greetingForHour(17)).toBe('Good afternoon');
  });
  test('evening 18–23', () => {
    expect(greetingForHour(18)).toBe('Good evening');
    expect(greetingForHour(23)).toBe('Good evening');
  });
});

const appr = (id: string): HomeApprovalItem => ({ approvalId: id, title: 't', workflowId: 'wf', runId: 'r', risk: 'medium' });
const fail = (id: string): HomeAttentionItem => ({ kind: 'run_failed', runId: id, workflowId: 'wf', at: '2026-08-13T10:00:00Z' });
const run = (id: string): HomeRunItem => ({ runId: id, workflowId: 'wf', status: 'running', startedAt: '2026-08-13T10:00:00Z' });

describe('homeSummaryLines', () => {
  test('counts approvals, running, failures with pluralization', () => {
    const lines = homeSummaryLines({ pendingApprovals: [appr('a'), appr('b'), appr('c')], running: [run('r')], attention: [fail('f')] });
    expect(lines.map((l) => l.text)).toEqual(['3 approvals need you', '1 workflow running', '1 recent failure']);
    expect(lines.map((l) => l.tone)).toEqual(['warn', 'accent', 'err']);
  });
  test('singular approval', () => {
    expect(homeSummaryLines({ pendingApprovals: [appr('a')], running: [], attention: [] })[0].text).toBe('1 approval need you');
  });
  test('empty → a single caught-up line (never fabricated activity)', () => {
    const lines = homeSummaryLines({ pendingApprovals: [], running: [], attention: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: "You're all caught up.", tone: 'dim' });
  });
});

describe('isFirstRun', () => {
  test('genuinely empty workspace → true', () => {
    expect(isFirstRun({ workflows: 0, customAgents: 0, runs: 0 })).toBe(true);
  });
  test('any real content → false', () => {
    expect(isFirstRun({ workflows: 1, customAgents: 0, runs: 0 })).toBe(false);
    expect(isFirstRun({ workflows: 0, customAgents: 1, runs: 0 })).toBe(false);
    expect(isFirstRun({ workflows: 0, customAgents: 0, runs: 1 })).toBe(false);
  });
});

describe('homeHermesStatus (cheap, never green when unknown)', () => {
  test('stub brain → stub (not green)', () => {
    expect(homeHermesStatus({ provider: 'stub' })).toEqual({ state: 'stub', label: 'Stub brain' });
  });
  test('never checked → unknown, never ok', () => {
    const s = homeHermesStatus({ provider: 'hermes', transport: 'acp', lastCheckAt: null, lastSuccessAt: null });
    expect(s.state).toBe('unknown');
    expect(s.label).toMatch(/unchecked/);
  });
  test('last check succeeded → ok with transport label', () => {
    const s = homeHermesStatus({ provider: 'hermes', transport: 'acp', lastCheckAt: '2026-08-13T10:00:00.000Z', lastSuccessAt: '2026-08-13T10:00:00.001Z' });
    expect(s.state).toBe('ok');
    expect(s.label).toBe('Hermes · ACP');
  });
  test('newer check without success → err (unreachable), never green', () => {
    const s = homeHermesStatus({ provider: 'hermes', transport: 'serve', lastCheckAt: '2026-08-13T12:00:00.000Z', lastSuccessAt: '2026-08-13T10:00:00.000Z' });
    expect(s.state).toBe('err');
    expect(s.label).toMatch(/unreachable/);
  });
  test('non-hermes provider label (gateway)', () => {
    const s = homeHermesStatus({ provider: 'gateway', lastCheckAt: '2026-08-13T10:00:00Z', lastSuccessAt: '2026-08-13T10:00:00Z' });
    expect(s.label).toBe('Gateway');
    expect(s.state).toBe('ok');
  });
});

describe('HOME_TARGETS (navigation → existing canonical surfaces)', () => {
  test('approval/failure/running/hermes/agents targets', () => {
    expect(HOME_TARGETS.approval).toBe('/approvals');
    expect(HOME_TARGETS.approvalsAll).toBe('/approvals');
    expect(HOME_TARGETS.failure).toBe('/flows');
    expect(HOME_TARGETS.running).toBe('/flows');
    expect(HOME_TARGETS.hermes).toBe('/settings');
    expect(HOME_TARGETS.agents).toBe('/agents');
  });
});
