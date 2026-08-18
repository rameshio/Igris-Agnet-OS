/**
 * UX Foundation U5, Part B — Agent Presence pure reducer.
 *
 * Pins the canonical states, the deterministic precedence
 * (working → waiting_approval → failed → idle), the recency guard that stops an
 * ancient failure (or a stale "running") from sticking, and that an agent with no
 * signal is idle (never guessed).
 */
import { describe, expect, test } from 'vitest';
import {
  reduceAllPresence,
  reducePresence,
  PRESENCE_RECENCY_MS,
  type PresenceSignal,
} from '@/lib/agents/presence';

const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const sig = (kind: PresenceSignal['kind'], over: Partial<PresenceSignal> = {}): PresenceSignal => ({
  kind,
  agentId: 'a1',
  at: ago(1000),
  workflowId: 'wf',
  workflowName: 'Gmail Daily',
  runId: 'run-1',
  ...over,
});

describe('reducePresence', () => {
  test('a running agent node → working (with workflow detail)', () => {
    const p = reducePresence('a1', [sig('working')], NOW);
    expect(p.state).toBe('working');
    expect(p.label).toBe('Working · running in Gmail Daily');
    expect(p.workflowName).toBe('Gmail Daily');
  });

  test('a pending approval on the agent’s run → waiting_approval', () => {
    const p = reducePresence('a1', [sig('waiting_approval')], NOW);
    expect(p.state).toBe('waiting_approval');
    expect(p.label).toMatch(/Waiting for approval/);
  });

  test('a recent agent failure → failed', () => {
    const p = reducePresence('a1', [sig('failed')], NOW);
    expect(p.state).toBe('failed');
    expect(p.label).toBe('Failed · latest run failed');
  });

  test('no signals → idle', () => {
    expect(reducePresence('a1', [], NOW).state).toBe('idle');
  });

  test('precedence: working beats a co-existing failure and waiting', () => {
    const p = reducePresence('a1', [sig('failed'), sig('waiting_approval'), sig('working')], NOW);
    expect(p.state).toBe('working');
  });

  test('precedence: waiting_approval beats a failure', () => {
    const p = reducePresence('a1', [sig('failed'), sig('waiting_approval')], NOW);
    expect(p.state).toBe('waiting_approval');
  });

  test('an ancient failure does not stick → idle', () => {
    const old = sig('failed', { at: ago(PRESENCE_RECENCY_MS + 60_000) });
    expect(reducePresence('a1', [old], NOW).state).toBe('idle');
  });

  test('a stale "running" (crashed run) also decays to idle', () => {
    const stale = sig('working', { at: ago(PRESENCE_RECENCY_MS + 60_000) });
    expect(reducePresence('a1', [stale], NOW).state).toBe('idle');
  });

  test('future-dated signals (clock skew) are ignored', () => {
    const future = sig('working', { at: new Date(NOW + 60_000).toISOString() });
    expect(reducePresence('a1', [future], NOW).state).toBe('idle');
  });

  test('within a kind, the newest signal wins', () => {
    const older = sig('working', { at: ago(5000), workflowName: 'Old WF' });
    const newer = sig('working', { at: ago(1000), workflowName: 'New WF' });
    const p = reducePresence('a1', [older, newer], NOW);
    expect(p.workflowName).toBe('New WF');
  });
});

describe('reduceAllPresence', () => {
  test('groups per agent, omits idle agents, deterministic order', () => {
    const signals: PresenceSignal[] = [
      sig('working', { agentId: 'b' }),
      sig('failed', { agentId: 'a' }),
      sig('waiting_approval', { agentId: 'c' }),
    ];
    const all = reduceAllPresence(signals, NOW);
    expect(all.map((p) => p.agentId)).toEqual(['a', 'b', 'c']); // sorted by id
    expect(all.map((p) => p.state)).toEqual(['failed', 'working', 'waiting_approval']);
  });

  test('an agent with only a stale signal is omitted (idle, not guessed)', () => {
    const all = reduceAllPresence([sig('failed', { agentId: 'z', at: ago(PRESENCE_RECENCY_MS + 1) })], NOW);
    expect(all).toHaveLength(0);
  });
});
