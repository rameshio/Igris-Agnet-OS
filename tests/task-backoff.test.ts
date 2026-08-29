/**
 * Reliability G4 — deterministic retry backoff for TRANSIENT auto-retryable failures.
 *
 * Covers: a transient failure earns a durable next_retry_at (A) but a config (B), exhausted
 * (C), unsafe (L), approval (M), unknown (N), and interrupted-review (R) failure never does;
 * the manager promote pass respects the delay — not before due (D), at due (E), after due (F) —
 * without consuming an attempt while waiting (G); the real dispatch after due increments once
 * (H); next_retry_at clears on queue (I), on completion (J), and does not interfere with a G3
 * reassignment (K); a still-eligible transient failure stays a SAME-agent retry (S); a G2 safe
 * interrupted task retries immediately with no backoff (Q); a config failure never loops (T);
 * exactly one TASK_RETRY_SCHEDULED per failed attempt (U) with no re-emission while waiting (V);
 * explicit operator retry may run early but never past max_attempts (O, P); and no timer/scheduler
 * is introduced (W). No real sleeps — a single injected clock drives all timing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import type { AgentRuntime } from '@/lib/agents/runtime';
import { createCustomAgent } from '@/lib/agents/custom';
import { createMission, createCompanyTask, getCompanyTask, assignTask } from '@/lib/company/service';
import { dispatchTask } from '@/lib/company/manager/delegation';
import { managerStep } from '@/lib/company/manager/service';
import { recoverStaleRunningTasks } from '@/lib/company/manager/recovery';
import { promoteRetryableFailures, retryTask, isRetryDue, retryTimingForTask } from '@/lib/company/manager/retry';
import { evaluateReassignment, reassignTaskIfWarranted } from '@/lib/company/manager/reassign';
import { computeRetryDelayMs, RETRY_BACKOFF_BASE_MS, RETRY_BACKOFF_MAX_MS } from '@/lib/company/manager/failure';

const prevLlm = process.env.LLM_PROVIDER;
beforeAll(() => {
  process.env.LLM_PROVIDER = 'stub'; // real custom-agent runs resolve ok:true deterministically
});
afterAll(() => {
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
});

type DB = ReturnType<typeof openDb>;

// A deterministic failing runtime that returns a chosen error code (no network).
function failingRuntime(code: string, summary = 'boom'): AgentRuntime {
  return {
    list: () => [],
    run: async (id: string) => ({
      id: `run-${Math.random().toString(36).slice(2)}`,
      agentId: id, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      ok: false, summary, errorCode: code, model: null, tokensIn: null, tokensOut: null, costUsd: null,
    }),
    broadcast: async () => ({ id: 'b', message: '', createdAt: '', replies: [] }),
  } as unknown as AgentRuntime;
}

function agentWithCap(db: DB, name: string, cap: string, tools: string[] = []): string {
  const a = createCustomAgent(db, { name, departmentId: 'dept-comms', instructions: 'Do work.', model: '', tools, enabled: true });
  db.capabilities.upsert({ id: cap, name: cap });
  db.agentCapabilities.assign(a.id, { capabilityId: cap });
  return a.id;
}

// research.market is a MODEL-ONLY capability (no tool requirement) → the agent stays eligible + SAFE.
function missionWithAgentTask(db: DB, tools: string[] = []): { missionId: string; taskId: string; agentId: string } {
  const agentId = agentWithCap(db, 'Scout', 'research.market', tools);
  const m = createMission(db, { title: 'M' });
  const task = createCompanyTask(db, m.id, { title: 'Market size', requiredCapabilities: ['research.market'] });
  return { missionId: m.id, taskId: task.id, agentId };
}

/** Simulate a task mid-dispatch when the process died: persisted `running`, no live execution. */
function craftStuckRunning(db: DB, tools: string[] = []): { missionId: string; taskId: string } {
  const { missionId, taskId, agentId } = missionWithAgentTask(db, tools);
  assignTask(db, taskId, agentId);
  const t = getCompanyTask(db, taskId)!;
  db.companyTasks.insert({ ...t, status: 'running', executionKind: 'agent', attemptCount: 1 });
  return { missionId, taskId };
}

/** now + ms as a Date (for the injected clock). */
const at = (base: number, ms: number): Date => new Date(base + ms);
/** A Date just past a task's scheduled next_retry_at. */
function dueAfter(db: DB, taskId: string): Date {
  return new Date(Date.parse(getCompanyTask(db, taskId)!.nextRetryAt!) + 1000);
}

// ── Pure backoff policy ────────────────────────────────────────────────────────
describe('backoff policy (pure, deterministic, bounded)', () => {
  test('attempt 1 → 15s, attempt 2 → 30s, attempt 3+ → 60s cap; non-transient → 0', () => {
    expect(computeRetryDelayMs({ failureClass: 'PROVIDER_TIMEOUT', attemptCount: 1, maxAttempts: 3 })).toBe(15_000);
    expect(computeRetryDelayMs({ failureClass: 'PROVIDER_RATE_LIMIT', attemptCount: 2, maxAttempts: 3 })).toBe(30_000);
    expect(computeRetryDelayMs({ failureClass: 'TRANSIENT_PROVIDER_ERROR', attemptCount: 3, maxAttempts: 5 })).toBe(60_000);
    expect(computeRetryDelayMs({ failureClass: 'CONNECTOR_UNAVAILABLE', attemptCount: 9, maxAttempts: 20 })).toBe(RETRY_BACKOFF_MAX_MS);
    expect(RETRY_BACKOFF_BASE_MS).toBe(15_000);
    // Not backoff-eligible: interruption (immediate recovery), config, approval, unknown, permanent.
    expect(computeRetryDelayMs({ failureClass: 'EXECUTION_INTERRUPTED', attemptCount: 1, maxAttempts: 3 })).toBe(0);
    expect(computeRetryDelayMs({ failureClass: 'TOOL_CONFIGURATION_MISSING', attemptCount: 1, maxAttempts: 3 })).toBe(0);
    expect(computeRetryDelayMs({ failureClass: 'APPROVAL_REQUIRED', attemptCount: 1, maxAttempts: 3 })).toBe(0);
    expect(computeRetryDelayMs({ failureClass: 'UNKNOWN_RUNTIME_FAILURE', attemptCount: 1, maxAttempts: 3 })).toBe(0);
  });
});

// ── Scheduling on failure (A, B, C, L, M, N) ────────────────────────────────────
describe('scheduling a next_retry_at on failure', () => {
  test('A: a transient auto-retryable failure gets a next_retry_at ~15s out', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    const before = Date.now();
    await dispatchTask(db, taskId, { runtime: failingRuntime('hermes_unavailable') }); // PROVIDER_TIMEOUT
    const t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('failed');
    expect(t.nextRetryAt).toBeTruthy();
    const delta = Date.parse(t.nextRetryAt!) - before;
    expect(delta).toBeGreaterThanOrEqual(15_000);
    expect(delta).toBeLessThan(20_000); // ~15s, not huge
  });

  test('B: a non-retryable config failure gets NO next_retry_at', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('credential_missing') }); // TOOL_CONFIGURATION_MISSING
    expect(getCompanyTask(db, taskId)!.nextRetryAt).toBeUndefined();
  });

  test('C: a retry-exhausted transient failure gets NO next_retry_at', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    db.companyTasks.insert({ ...getCompanyTask(db, taskId)!, maxAttempts: 1 });
    await dispatchTask(db, taskId, { runtime: failingRuntime('network_error') }); // attempt 1 == max
    const t = getCompanyTask(db, taskId)!;
    expect(t.attemptCount).toBe(1);
    expect(t.nextRetryAt).toBeUndefined(); // budget spent — no backoff scheduled
  });

  test('L: an UNSAFE side-effect task never receives an automatic backoff', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db, ['telegram']); // telegram = external side-effect tool
    await dispatchTask(db, taskId, { runtime: failingRuntime('hermes_unavailable') }); // transient
    const t = getCompanyTask(db, taskId)!;
    expect(t.lastFailureClass).toBe('PROVIDER_TIMEOUT');
    expect(t.nextRetryAt).toBeUndefined(); // auto-retry is off → no scheduled time
  });

  test('M: an approval-required failure never receives an automatic backoff', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('hermes_approval_required') });
    const t = getCompanyTask(db, taskId)!;
    expect(t.lastFailureClass).toBe('APPROVAL_REQUIRED');
    expect(t.nextRetryAt).toBeUndefined();
  });

  test('N: an UNKNOWN automatic failure never receives a backoff', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('node_error', 'unknown crash') });
    const t = getCompanyTask(db, taskId)!;
    expect(t.lastFailureClass).toBe('UNKNOWN_RUNTIME_FAILURE');
    expect(t.nextRetryAt).toBeUndefined();
  });
});

// ── Due-gating in the promote pass (D, E, F, G, H, I) ───────────────────────────
describe('the manager promote pass honours the backoff window', () => {
  test('D + G: before due, the task is NOT queued and no attempt is consumed', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('hermes_unavailable') });
    const failedAt = Date.parse(getCompanyTask(db, taskId)!.nextRetryAt!) - 15_000;
    const before = at(failedAt, 5_000); // 5s in, well before the 15s mark
    expect(isRetryDue(getCompanyTask(db, taskId)!, before)).toBe(false);
    expect(promoteRetryableFailures(db, missionId, { now: before })).not.toContain(taskId);
    const t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('failed'); // still failed
    expect(t.attemptCount).toBe(1); // G: no attempt burned while waiting
    expect(t.nextRetryAt).toBeTruthy(); // still scheduled
  });

  test('E: exactly at due, the task IS queued', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('hermes_unavailable') });
    const exact = new Date(Date.parse(getCompanyTask(db, taskId)!.nextRetryAt!));
    expect(promoteRetryableFailures(db, missionId, { now: exact })).toContain(taskId);
    expect(getCompanyTask(db, taskId)!.status).toBe('queued');
  });

  test('F + I: after due, the task IS queued and next_retry_at is cleared', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('network_error') });
    expect(promoteRetryableFailures(db, missionId, { now: dueAfter(db, taskId) })).toContain(taskId);
    const t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('queued');
    expect(t.nextRetryAt).toBeUndefined(); // I: cleared on queue
  });

  test('H + J: the real dispatch after due increments the attempt once and completes clearing timing', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('network_error') }); // attempt 1
    promoteRetryableFailures(db, missionId, { now: dueAfter(db, taskId) }); // → queued
    await dispatchTask(db, taskId); // healthy → completed
    const t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('completed');
    expect(t.attemptCount).toBe(2); // H: incremented exactly once
    expect(t.nextRetryAt).toBeUndefined(); // J: cleared
    expect(db.companyArtifacts.forTask(taskId)).toHaveLength(1);
  });
});

// ── Interaction with G3 reassignment + same-agent boundary (K, S) ────────────────
describe('G3 reassignment interaction', () => {
  test('K: reassignment clears stale backoff and queues immediately (not delayed)', async () => {
    const db = openDb(':memory:');
    const a = agentWithCap(db, 'A', 'research.market');
    const b = agentWithCap(db, 'B', 'research.market');
    const m = createMission(db, { title: 'M' });
    const task = createCompanyTask(db, m.id, { title: 'T', requiredCapabilities: ['research.market'] });
    assignTask(db, task.id, a);
    await dispatchTask(db, task.id, { runtime: failingRuntime('hermes_unavailable') }); // transient → nextRetryAt set
    expect(getCompanyTask(db, task.id)!.nextRetryAt).toBeTruthy();
    db.agentCapabilities.remove(a, 'research.market'); // A becomes ineligible → agent-specific

    const decision = reassignTaskIfWarranted(db, task.id);
    expect(decision.decision).toBe('REASSIGN_ALLOWED');
    expect(decision.toAgentId).toBe(b);
    const t = getCompanyTask(db, task.id)!;
    expect(t.status).toBe('queued'); // queued immediately by reassignment
    expect(t.assignedAgentId).toBe(b);
    expect(t.nextRetryAt).toBeUndefined(); // stale provider backoff cleared — B is not made to wait
  });

  test('S: a still-eligible transient failure stays a SAME-agent retry (not rotated)', async () => {
    const db = openDb(':memory:');
    const a = agentWithCap(db, 'A', 'research.market');
    agentWithCap(db, 'B', 'research.market'); // an alternate exists, but must NOT be used
    const m = createMission(db, { title: 'M' });
    const task = createCompanyTask(db, m.id, { title: 'T', requiredCapabilities: ['research.market'] });
    assignTask(db, task.id, a);
    await dispatchTask(db, task.id, { runtime: failingRuntime('network_error') }); // transient, A still eligible
    // G3 leaves it to G1 (same agent) — never rotates a provider-transient failure.
    expect(evaluateReassignment(db, task.id).decision).toBe('FAILURE_NOT_AGENT_SPECIFIC');
    promoteRetryableFailures(db, m.id, { now: dueAfter(db, task.id) }); // due → re-queued
    expect(getCompanyTask(db, task.id)!.assignedAgentId).toBe(a); // still A (same provider/agent)
  });
});

// ── G2 recovery interaction (Q, R) ───────────────────────────────────────────────
describe('G2 recovery interaction', () => {
  test('Q: a safe interrupted task gets NO backoff and retries immediately', () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = craftStuckRunning(db);
    recoverStaleRunningTasks(db, missionId); // → failed(EXECUTION_INTERRUPTED), attempt 1
    const t = getCompanyTask(db, taskId)!;
    expect(t.lastFailureClass).toBe('EXECUTION_INTERRUPTED');
    expect(t.nextRetryAt).toBeUndefined(); // interruption is manager-recovered, not provider-delayed
    // Promotes immediately on the very next pass (real clock — no wait needed).
    expect(promoteRetryableFailures(db, missionId)).toContain(taskId);
  });

  test('R: an unsafe interrupted task is review-required with no automatic retry time', () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = craftStuckRunning(db, ['telegram']);
    recoverStaleRunningTasks(db, missionId);
    const t = getCompanyTask(db, taskId)!;
    expect(t.lastFailureClass).toBe('INTERRUPTED_REVIEW_REQUIRED');
    expect(t.nextRetryAt).toBeUndefined();
    expect(promoteRetryableFailures(db, missionId)).not.toContain(taskId);
  });
});

// ── Explicit operator retry policy (O, P) ────────────────────────────────────────
describe('explicit operator retry policy', () => {
  test('O: explicit retry MAY run early (bypasses the backoff delay), clearing the timer', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('hermes_unavailable') });
    const t0 = getCompanyTask(db, taskId)!;
    expect(t0.nextRetryAt).toBeTruthy();
    expect(isRetryDue(t0, new Date())).toBe(false); // not due yet
    const res = retryTask(db, taskId); // operator acknowledged early retry
    expect(res.ok).toBe(true);
    const t1 = getCompanyTask(db, taskId)!;
    expect(t1.status).toBe('queued'); // ran despite the pending delay
    expect(t1.nextRetryAt).toBeUndefined(); // cleared on queue
  });

  test('P: early explicit retry still cannot bypass max_attempts', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    db.companyTasks.insert({ ...getCompanyTask(db, taskId)!, maxAttempts: 1 });
    await dispatchTask(db, taskId, { runtime: failingRuntime('hermes_unavailable') }); // attempt 1 == max
    const res = retryTask(db, taskId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.decision.decision).toBe('RETRY_EXHAUSTED');
  });
});

// ── Config never loops + timing read model (T) ──────────────────────────────────
describe('T: a tool-configuration failure never loops', () => {
  test('repeated promote passes (any clock) never retry a config failure', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('credential_missing') });
    const future = at(Date.now(), 10 * 60_000);
    expect(promoteRetryableFailures(db, missionId)).toHaveLength(0);
    expect(promoteRetryableFailures(db, missionId, { now: future })).toHaveLength(0);
    expect(getCompanyTask(db, taskId)!.status).toBe('failed');
    const timing = retryTimingForTask(db, taskId)!;
    expect(timing.nextRetryAt).toBeNull();
    expect(timing.retryDue).toBe(true); // "due" only in the sense that there is no delay gating it
  });
});

// ── Event semantics (U, V) ──────────────────────────────────────────────────────
describe('scheduling event semantics', () => {
  test('U: exactly one TASK_RETRY_SCHEDULED per failed attempt', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('hermes_unavailable') });
    expect(db.companyEvents.countForTask(taskId, 'TASK_RETRY_SCHEDULED')).toBe(1);
  });

  test('V: waiting through many promote ticks never re-emits a scheduling event and never queues', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('hermes_unavailable') });
    const failBase = Date.parse(getCompanyTask(db, taskId)!.nextRetryAt!) - 15_000;
    for (const ms of [1_000, 3_000, 7_000, 12_000]) {
      expect(promoteRetryableFailures(db, missionId, { now: at(failBase, ms) })).toHaveLength(0);
    }
    expect(db.companyEvents.countForTask(taskId, 'TASK_RETRY_SCHEDULED')).toBe(1); // still exactly one
    expect(db.companyEvents.countForTask(taskId, 'TASK_RETRY_QUEUED')).toBe(0); // never queued while waiting
    expect(getCompanyTask(db, taskId)!.status).toBe('failed');
  });
});

// ── Manual scenario via managerStep (the item-20 walkthrough) ────────────────────
describe('managerStep integration — the manual backoff scenario', () => {
  test('transient fail → not retried before due → retried + completed after due, one artifact', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithAgentTask(db);
    // 1–5: a safe task fails attempt 1 with a transient timeout → next_retry_at is set.
    await dispatchTask(db, taskId, { runtime: failingRuntime('hermes_unavailable') });
    expect(getCompanyTask(db, taskId)!.attemptCount).toBe(1);
    const nextRetryAt = Date.parse(getCompanyTask(db, taskId)!.nextRetryAt!);

    // 6–7: a managerStep BEFORE due leaves it failed, attempt unchanged.
    await managerStep(db, missionId, { now: new Date(nextRetryAt - 5_000) });
    let t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('failed');
    expect(t.attemptCount).toBe(1);
    expect(t.nextRetryAt).toBeTruthy();

    // 8–14: advance the injected clock past due → recovered → retried → dispatched → completed.
    await managerStep(db, missionId, { now: new Date(nextRetryAt + 1_000) });
    t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('completed');
    expect(t.attemptCount).toBe(2); // exactly one further real attempt
    expect(t.nextRetryAt).toBeUndefined(); // cleared
    expect(db.companyArtifacts.forTask(taskId)).toHaveLength(1); // one final artifact
    const types = db.companyEvents.forTask(taskId).map((e) => e.type);
    expect(types).toContain('TASK_RETRY_SCHEDULED');
    expect(types).toContain('TASK_RETRY_QUEUED');
    expect(types).toContain('TASK_COMPLETED');
  });
});

// ── W: no timers / scheduler / background retry mechanism ─────────────────────────
describe('W: no background timer/scheduler is introduced', () => {
  test('the backoff + retry sources use no timers/intervals', () => {
    for (const file of ['failure.ts', 'retry.ts', 'service.ts', 'recovery.ts', 'reassign.ts']) {
      const src = readFileSync(path.join(process.cwd(), 'lib', 'company', 'manager', file), 'utf8');
      expect(src).not.toMatch(/setInterval|setTimeout|setImmediate/);
    }
  });
});
