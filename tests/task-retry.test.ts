/**
 * Reliability G1 — runtime error-code preservation + bounded company-task retry.
 *
 * Covers: runtime preserves the code (A) + generic code (B) + secret redaction (O);
 * attempt increments only on a real dispatch (C) and not on eligibility/gap (D);
 * retryable failures retry (E) but missing-config (F)/capability-gap (G)/approval (M)
 * do not; retry stops at max (H); ordinary transitions still reject failed→queued (I)
 * while the dedicated retry path performs it (J); a successful retry completes (K)
 * with the artifact dedup intact (L); and the explicit retry rejects non-retryable (N).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import { createRuntime, type AgentRuntime, type RuntimeAgent } from '@/lib/agents/runtime';
import { createCustomAgent } from '@/lib/agents/custom';
import { ModelRouteError } from '@/lib/models/types';
import { createMission, createCompanyTask, getCompanyTask, updateCompanyTask, getEligibleAgentsForTask } from '@/lib/company/service';
import { dispatchTask } from '@/lib/company/manager/delegation';
import { promoteRetryableFailures, retryTask, retryDecisionForTask } from '@/lib/company/manager/retry';

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

function agentWithCap(db: DB, name: string, cap: string): string {
  const a = createCustomAgent(db, { name, departmentId: 'dept-comms', instructions: 'Do work.', model: '', tools: [], enabled: true });
  db.capabilities.upsert({ id: cap, name: cap });
  db.agentCapabilities.assign(a.id, { capabilityId: cap });
  return a.id;
}

// research.market is a MODEL-ONLY capability (no tool requirement) — keeps the agent eligible.
function missionWithAgentTask(db: DB): { missionId: string; taskId: string; agentId: string } {
  const agentId = agentWithCap(db, 'Scout', 'research.market');
  const m = createMission(db, { title: 'M' });
  const task = createCompanyTask(db, m.id, { title: 'Market size', requiredCapabilities: ['research.market'] });
  return { missionId: m.id, taskId: task.id, agentId };
}

describe('runtime preserves the error code (IP-1)', () => {
  test('A: a thrown ModelRouteError is preserved as the agent run error_code', async () => {
    const db = openDb(':memory:');
    const agent: RuntimeAgent = { id: 'thr', name: 'T', description: '', departmentId: 'dept-tech', run: async () => { throw new ModelRouteError('rate_limited', 'rate limited'); } };
    const run = await createRuntime(db, [agent]).run('thr');
    expect(run.ok).toBe(false);
    expect(run.errorCode).toBe('rate_limited');
    expect(db.agentRuns.byAgent('thr')[0].errorCode).toBe('rate_limited'); // durable
  });

  test('B: an unknown thrown error gets a deterministic generic code', async () => {
    const db = openDb(':memory:');
    const agent: RuntimeAgent = { id: 'boom', name: 'B', description: '', departmentId: 'dept-tech', run: async () => { throw new Error('kaboom'); } };
    const run = await createRuntime(db, [agent]).run('boom');
    expect(run.ok).toBe(false);
    expect(run.errorCode).toBe('node_error');
  });

  test('O: a secret in the error message is redacted in the run summary', async () => {
    const db = openDb(':memory:');
    const agent: RuntimeAgent = { id: 'leak', name: 'L', description: '', departmentId: 'dept-tech', run: async () => { throw new Error('auth failed with sk-abcdef1234567 leaked'); } };
    const run = await createRuntime(db, [agent]).run('leak');
    expect(run.summary).not.toContain('sk-abcdef1234567');
    expect(run.summary).toContain('[redacted-key]');
  });

  test('a successful run carries no error code', async () => {
    const db = openDb(':memory:');
    const agent: RuntimeAgent = { id: 'ok', name: 'K', description: '', departmentId: 'dept-tech', run: async () => ({ ok: true, summary: 'done' }) };
    const run = await createRuntime(db, [agent]).run('ok');
    expect(run.ok).toBe(true);
    expect(run.errorCode ?? null).toBeNull();
  });
});

describe('attempt tracking (C, D)', () => {
  test('C: a new task starts at 0 and the first real dispatch increments to 1', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    expect(getCompanyTask(db, taskId)!.attemptCount).toBe(0);
    await dispatchTask(db, taskId); // real runtime → success
    expect(getCompanyTask(db, taskId)!.attemptCount).toBe(1);
  });

  test('D: eligibility checks and a capability gap do NOT consume an attempt', async () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const gap = createCompanyTask(db, m.id, { title: 'Legal review', requiredCapabilities: ['legal.canada'] });
    getEligibleAgentsForTask(db, gap.id); // eligibility read
    const r = await dispatchTask(db, gap.id); // capability gap → stays queued
    expect(r.outcome).toBe('capability_gap');
    expect(getCompanyTask(db, gap.id)!.status).toBe('queued');
    expect(getCompanyTask(db, gap.id)!.attemptCount).toBe(0); // no attempt burned (G too)
  });
});

describe('retry decisions + execution (E, F, H, I, J, K, L, N)', () => {
  test('E: a retryable provider timeout auto-retries on the next manager pass', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('hermes_unavailable') });
    let t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('failed');
    expect(t.attemptCount).toBe(1);
    expect(t.lastFailureClass).toBe('PROVIDER_TIMEOUT');

    const promoted = promoteRetryableFailures(db, missionId); // manager auto-retry pass
    expect(promoted).toContain(taskId);
    expect(getCompanyTask(db, taskId)!.status).toBe('queued'); // controlled failed→queued
    expect(db.companyEvents.forTask(taskId).some((e) => e.type === 'TASK_RETRY_QUEUED')).toBe(true);

    // Re-dispatch (now with a healthy runtime) completes and increments the attempt to 2.
    await dispatchTask(db, taskId);
    t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('completed');
    expect(t.attemptCount).toBe(2);
  });

  test('F: a missing tool/config failure is NOT auto-retried and rejects explicit retry', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('credential_missing') });
    expect(getCompanyTask(db, taskId)!.lastFailureClass).toBe('TOOL_CONFIGURATION_MISSING');
    expect(promoteRetryableFailures(db, missionId)).toHaveLength(0); // never auto-retried
    const res = retryTask(db, taskId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.decision.decision).toBe('HUMAN_ACTION_REQUIRED');
    expect(getCompanyTask(db, taskId)!.attemptCount).toBe(1); // does not burn more attempts
  });

  test('H: auto-retry stops at max_attempts and records TASK_RETRY_EXHAUSTED', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithAgentTask(db);
    // Tighten the budget to 2 (direct write of the additive field).
    db.companyTasks.insert({ ...getCompanyTask(db, taskId)!, maxAttempts: 2 });

    await dispatchTask(db, taskId, { runtime: failingRuntime('network_error') }); // attempt 1
    expect(promoteRetryableFailures(db, missionId)).toContain(taskId);
    await dispatchTask(db, taskId, { runtime: failingRuntime('network_error') }); // attempt 2
    const promoted = promoteRetryableFailures(db, missionId); // budget spent
    expect(promoted).toHaveLength(0);
    const t = getCompanyTask(db, taskId)!;
    expect(t.attemptCount).toBe(2);
    expect(t.status).toBe('failed');
    expect(db.companyEvents.forTask(taskId).some((e) => e.type === 'TASK_RETRY_EXHAUSTED')).toBe(true);
    // A further pass never revives it (no infinite loop).
    expect(promoteRetryableFailures(db, missionId)).toHaveLength(0);
    expect(getCompanyTask(db, taskId)!.status).toBe('failed');
  });

  test('I: ordinary updateCompanyTask still rejects failed→queued', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('network_error') });
    expect(getCompanyTask(db, taskId)!.status).toBe('failed');
    expect(() => updateCompanyTask(db, taskId, { status: 'queued' })).toThrow(/invalid task transition/);
  });

  test('J + K + L: the retry path moves failed→queued, re-dispatch completes, one artifact', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('network_error') }); // attempt 1, failed
    expect(db.companyArtifacts.forTask(taskId)).toHaveLength(0); // a failed attempt makes no artifact

    const res = retryTask(db, taskId); // J: dedicated controlled failed→queued
    expect(res.ok).toBe(true);
    expect(getCompanyTask(db, taskId)!.status).toBe('queued');

    await dispatchTask(db, taskId); // K: healthy runtime → completes
    const t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('completed');
    expect(t.attemptCount).toBe(2);
    expect(db.companyArtifacts.forTask(taskId)).toHaveLength(1); // L: exactly one artifact

    // Dispatching a completed task never re-runs or duplicates the artifact.
    const again = await dispatchTask(db, taskId);
    expect(again.outcome).toBe('already_active');
    expect(db.companyArtifacts.forTask(taskId)).toHaveLength(1);
  });

  test('N: explicit retry rejects a non-failed task', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId); // success → completed
    const res = retryTask(db, taskId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.decision.decision).toBe('NOT_RETRYABLE');
  });
});

describe('M: an approval-required failure never bypasses approval', () => {
  test('an APPROVAL_REQUIRED-coded failure is not auto-retried and rejects explicit retry', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('hermes_approval_required') });
    expect(getCompanyTask(db, taskId)!.lastFailureClass).toBe('APPROVAL_REQUIRED');
    expect(promoteRetryableFailures(db, missionId)).toHaveLength(0); // no auto-retry around approval
    const decision = retryDecisionForTask(db, taskId)!;
    expect(decision.decision).toBe('HUMAN_ACTION_REQUIRED');
    expect(retryTask(db, taskId).ok).toBe(false);
  });
});

describe('P: UNKNOWN_RUNTIME_FAILURE explicit human retry vs auto-retry rules', () => {
  test('1. UNKNOWN_RUNTIME_FAILURE is NOT automatically retried by manager step', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('node_error', 'unknown crash') });
    const t = getCompanyTask(db, taskId)!;
    expect(t.lastFailureClass).toBe('UNKNOWN_RUNTIME_FAILURE');
    expect(t.status).toBe('failed');
    expect(promoteRetryableFailures(db, missionId)).toHaveLength(0); // auto-retry skipped
    expect(getCompanyTask(db, taskId)!.status).toBe('failed');
  });

  test('2. UNKNOWN_RUNTIME_FAILURE CAN be explicitly retried by human operator when budget remains', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime('node_error', 'unknown crash') });
    expect(getCompanyTask(db, taskId)!.attemptCount).toBe(1);

    const res = retryTask(db, taskId);
    expect(res.ok).toBe(true);
    expect(getCompanyTask(db, taskId)!.status).toBe('queued');
  });

  test('3. UNKNOWN_RUNTIME_FAILURE explicit retry cannot exceed maxAttempts', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithAgentTask(db);
    db.companyTasks.insert({ ...getCompanyTask(db, taskId)!, maxAttempts: 1 });
    await dispatchTask(db, taskId, { runtime: failingRuntime('node_error', 'unknown crash') });
    expect(getCompanyTask(db, taskId)!.attemptCount).toBe(1);

    const res = retryTask(db, taskId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.decision.decision).toBe('RETRY_EXHAUSTED');
  });
});

describe('Q: CHECK 2 — external side-effect retry safety', () => {
  test('an unsafe external side-effect task (e.g. telegram tool) does NOT automatically retry on transient failure', async () => {
    const db = openDb(':memory:');
    // Agent connected to external message tool 'telegram' (side-effect)
    const agent = createCustomAgent(db, { name: 'CommsBot', departmentId: 'dept-comms', instructions: 'Send message.', model: '', tools: ['telegram'], enabled: true });
    db.capabilities.upsert({ id: 'messaging.send', name: 'messaging.send' });
    db.agentCapabilities.assign(agent.id, { capabilityId: 'messaging.send' });
    const m = createMission(db, { title: 'M' });
    const task = createCompanyTask(db, m.id, { title: 'Broadcast alert', requiredCapabilities: ['messaging.send'] });

    // Fails with a transient provider error (hermes_unavailable / PROVIDER_TIMEOUT)
    await dispatchTask(db, task.id, { runtime: failingRuntime('hermes_unavailable') });
    const failedTask = getCompanyTask(db, task.id)!;
    expect(failedTask.status).toBe('failed');
    expect(failedTask.lastFailureClass).toBe('PROVIDER_TIMEOUT');

    // Auto-retry must NOT automatically retry this unsafe external task
    const promoted = promoteRetryableFailures(db, m.id);
    expect(promoted).not.toContain(task.id);
    expect(getCompanyTask(db, task.id)!.status).toBe('failed');

    // Human explicit retry CAN retry it with explicit operator confirmation
    const explicitRes = retryTask(db, task.id);
    expect(explicitRes.ok).toBe(true);
    expect(getCompanyTask(db, task.id)!.status).toBe('queued');
  });
});

