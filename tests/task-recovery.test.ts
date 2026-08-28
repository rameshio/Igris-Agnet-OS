/**
 * Reliability G2 — stale-running recovery for agent-backed Company Tasks.
 *
 * Covers: a dead agent execution is detected (A) but a live one is not (B); recovery
 * never increments attempt_count (C) and preserves history/events (H); a recovered safe
 * task flows through the G1 retry path (D) and the next dispatch increments once (E) with
 * one final artifact; max_attempts is still enforced (F); the same stale task is not
 * recovered twice (G); no artifact is created during recovery (I); completed (J) and
 * queued/waiting (K) tasks are untouched; an unsafe side-effect task is review-required,
 * never auto/one-click retried (L, M); workflow tasks are left to reconcileTask (N);
 * managerStep runs recovery before retry/dispatch (O); no scheduler/timer is introduced (P).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import type { AgentRuntime } from '@/lib/agents/runtime';
import { createCustomAgent } from '@/lib/agents/custom';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { createMission, createCompanyTask, getCompanyTask, updateCompanyTask, assignTask } from '@/lib/company/service';
import { dispatchTask } from '@/lib/company/manager/delegation';
import { managerStep } from '@/lib/company/manager/service';
import { recoverStaleRunningTasks } from '@/lib/company/manager/recovery';
import { promoteRetryableFailures, retryTask } from '@/lib/company/manager/retry';

const prevLlm = process.env.LLM_PROVIDER;
beforeAll(() => {
  process.env.LLM_PROVIDER = 'stub';
});
afterAll(() => {
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
});

type DB = ReturnType<typeof openDb>;

function agentWithCap(db: DB, name: string, cap: string, tools: string[] = []): string {
  const a = createCustomAgent(db, { name, departmentId: 'dept-comms', instructions: 'Do work.', model: '', tools, enabled: true });
  db.capabilities.upsert({ id: cap, name: cap });
  db.agentCapabilities.assign(a.id, { capabilityId: cap });
  return a.id;
}

/** A queued task + an eligible agent (research.market is model-only → no tool requirement). */
function missionWithAgentTask(db: DB, tools: string[] = []): { missionId: string; taskId: string; agentId: string } {
  const agentId = agentWithCap(db, 'Scout', 'research.market', tools);
  const m = createMission(db, { title: 'M' });
  const task = createCompanyTask(db, m.id, { title: 'Market size', requiredCapabilities: ['research.market'] });
  return { missionId: m.id, taskId: task.id, agentId };
}

/** Simulate a task that was mid-dispatch when the process died: persisted `running`, no live execution. */
function craftStuckRunning(db: DB, opts: { tools?: string[]; attemptCount?: number; maxAttempts?: number } = {}): { missionId: string; taskId: string; agentId: string } {
  const { missionId, taskId, agentId } = missionWithAgentTask(db, opts.tools ?? []);
  assignTask(db, taskId, agentId); // queued → assigned (capability-compat checked)
  const t = getCompanyTask(db, taskId)!;
  db.companyTasks.insert({ ...t, status: 'running', executionKind: 'agent', attemptCount: opts.attemptCount ?? 1, maxAttempts: opts.maxAttempts ?? t.maxAttempts });
  return { missionId, taskId, agentId };
}

describe('detection (A, B)', () => {
  test('A: a running agent task with no live execution is detected and recovered', () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = craftStuckRunning(db);
    const outcomes = recoverStaleRunningTasks(db, missionId);
    expect(outcomes.find((o) => o.taskId === taskId)?.state).toBe('RECOVERED_INTERRUPTED');
    const t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('failed');
    expect(t.lastFailureClass).toBe('EXECUTION_INTERRUPTED');
    expect(t.lastFailureCode).toBe('execution_interrupted');
    expect(t.attemptCount).toBe(1); // C: not incremented
    expect(db.companyEvents.forTask(taskId).some((e) => e.type === 'TASK_EXECUTION_INTERRUPTED')).toBe(true); // H
    expect(db.companyArtifacts.forTask(taskId)).toHaveLength(0); // I
  });

  test('B: a genuinely in-flight agent dispatch is reported ACTIVE and left running', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithAgentTask(db);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const rt = {
      list: () => [],
      run: async (id: string) => { await gate; return { id: 'run-live', agentId: id, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, summary: 'done', errorCode: null, model: null, tokensIn: null, tokensOut: null, costUsd: null }; },
      broadcast: async () => ({ id: 'b', message: '', createdAt: '', replies: [] }),
    } as unknown as AgentRuntime;

    const p = dispatchTask(db, taskId, { runtime: rt }); // synchronously reaches the awaited run → task running + ACTIVE
    expect(getCompanyTask(db, taskId)!.status).toBe('running');
    const outcomes = recoverStaleRunningTasks(db, missionId);
    expect(outcomes.find((o) => o.taskId === taskId)?.state).toBe('ACTIVE'); // NOT recovered
    expect(getCompanyTask(db, taskId)!.status).toBe('running'); // untouched
    release();
    await p;
    expect(getCompanyTask(db, taskId)!.status).toBe('completed'); // the live run finished normally
  });
});

describe('recovered task flows through the G1 retry machinery (D, E, G)', () => {
  test('D + E: recovered safe task auto-promotes, then the next dispatch increments once and completes', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = craftStuckRunning(db);
    recoverStaleRunningTasks(db, missionId); // → failed(EXECUTION_INTERRUPTED), attempt 1
    expect(promoteRetryableFailures(db, missionId)).toContain(taskId); // D
    expect(getCompanyTask(db, taskId)!.status).toBe('queued');

    await dispatchTask(db, taskId); // healthy re-dispatch
    const t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('completed');
    expect(t.attemptCount).toBe(2); // E: incremented exactly once
    expect(db.companyArtifacts.forTask(taskId)).toHaveLength(1);
  });

  test('G: the same stale task is not recovered twice (one interruption event)', () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = craftStuckRunning(db);
    recoverStaleRunningTasks(db, missionId);
    const second = recoverStaleRunningTasks(db, missionId); // task is now failed, not running
    expect(second.find((o) => o.taskId === taskId)).toBeUndefined();
    expect(db.companyEvents.forTask(taskId).filter((e) => e.type === 'TASK_EXECUTION_INTERRUPTED')).toHaveLength(1);
  });
});

describe('budget + safety (F, L, M)', () => {
  test('F: recovery at exhausted budget stays failed and emits retry-exhausted, never re-queues', () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = craftStuckRunning(db, { attemptCount: 3, maxAttempts: 3 });
    recoverStaleRunningTasks(db, missionId);
    expect(promoteRetryableFailures(db, missionId)).toHaveLength(0); // budget spent
    const t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('failed');
    expect(t.attemptCount).toBe(3);
    expect(db.companyEvents.forTask(taskId).some((e) => e.type === 'TASK_RETRY_EXHAUSTED')).toBe(true);
  });

  test('L + M: an interrupted UNSAFE side-effect task is review-required, never auto/one-click retried', () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = craftStuckRunning(db, { tools: ['telegram'] }); // telegram = side-effect tool
    const outcomes = recoverStaleRunningTasks(db, missionId);
    expect(outcomes.find((o) => o.taskId === taskId)?.state).toBe('RECOVERED_REVIEW_REQUIRED');
    const t = getCompanyTask(db, taskId)!;
    expect(t.lastFailureClass).toBe('INTERRUPTED_REVIEW_REQUIRED');
    expect(promoteRetryableFailures(db, missionId)).toHaveLength(0); // never auto-retried (M)
    const res = retryTask(db, taskId); // explicit one-click retry rejected
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.decision.decision).toBe('HUMAN_ACTION_REQUIRED');
    expect(getCompanyTask(db, taskId)!.attemptCount).toBe(1); // no attempt burned
  });
});

describe('untouched states (J, K, N)', () => {
  test('J + K: completed / queued / waiting_dependency tasks are never recovered', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const done = createCompanyTask(db, m.id, { title: 'done' });
    db.companyTasks.insert({ ...getCompanyTask(db, done.id)!, status: 'completed' });
    const queued = createCompanyTask(db, m.id, { title: 'queued' });
    const waiting = createCompanyTask(db, m.id, { title: 'waiting' });
    db.companyTasks.insert({ ...getCompanyTask(db, waiting.id)!, status: 'waiting_dependency' });

    const outcomes = recoverStaleRunningTasks(db, m.id);
    expect(outcomes).toHaveLength(0);
    expect(getCompanyTask(db, done.id)!.status).toBe('completed');
    expect(getCompanyTask(db, queued.id)!.status).toBe('queued');
    expect(getCompanyTask(db, waiting.id)!.status).toBe('waiting_dependency');
  });

  test('N: a running WORKFLOW task is left to reconcileTask (recovery does not touch it)', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const task = createCompanyTask(db, m.id, { title: 'wf' });
    // Simulate a running workflow task (executionKind workflow) — G2 recovery must skip it.
    db.companyTasks.insert({ ...getCompanyTask(db, task.id)!, status: 'running', executionKind: 'workflow', executionRefId: 'run-x', attemptCount: 1 });
    const outcomes = recoverStaleRunningTasks(db, m.id);
    expect(outcomes.find((o) => o.taskId === task.id)).toBeUndefined(); // not owned by G2
    expect(getCompanyTask(db, task.id)!.status).toBe('running'); // untouched by recovery
  });
});

describe('managerStep integration (O) — the manual recovery scenario', () => {
  test('O: managerStep recovers a stale-running task, then retries + completes in one bounded tick', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = craftStuckRunning(db); // running(agent), attempt 1, no live execution
    const result = await managerStep(db, missionId);
    const t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('completed'); // recovered → auto-retried → dispatched → completed
    expect(t.attemptCount).toBe(2); // exactly one further real attempt
    expect(db.companyArtifacts.forTask(taskId)).toHaveLength(1); // exactly one final artifact
    const types = db.companyEvents.forTask(taskId).map((e) => e.type);
    expect(types).toContain('TASK_EXECUTION_INTERRUPTED'); // recovery event preserved
    expect(types).toContain('TASK_RETRY_QUEUED');
    expect(types).toContain('TASK_COMPLETED');
    expect(result.mission.id).toBe(missionId);
  });
});

describe('P: no background scheduler/timer is introduced', () => {
  test('the recovery service uses no timers/intervals', () => {
    const src = readFileSync(path.join(process.cwd(), 'lib', 'company', 'manager', 'recovery.ts'), 'utf8');
    expect(src).not.toMatch(/setInterval|setTimeout|setImmediate/);
  });
});
