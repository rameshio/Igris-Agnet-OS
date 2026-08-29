/**
 * Reliability G3 — controlled agent reassignment.
 *
 * Covers the pure decision layer + the service integration: an agent-specific safe failure
 * reassigns to another ELIGIBLE agent (A) that must be fully capability- (B) and wired-tool-
 * eligible (C); the failed agent is excluded (D) and selection is deterministic (E);
 * reassignment never increments attempt_count (F) but the next dispatch does (G); prior agent
 * history survives (H); one TASK_REASSIGNED fires (I); no alternate ⇒ stays failed (J, S); a
 * capability gap (K), global tool-config-missing (L), approval (N), and unsafe side-effect (O)
 * never reassign; a provider timeout on a still-eligible agent does NOT rotate agents (M, T);
 * max_attempts blocks it (P); completed (Q) and workflow (R) tasks are untouched; no
 * force-target/bypass exists (V); managerStep drives the whole flow.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import type { AgentRuntime } from '@/lib/agents/runtime';
import { createCustomAgent } from '@/lib/agents/custom';
import { allRuntimeAgents, getAgentById } from '@/lib/agents/registry';
import { createMission, createCompanyTask, getCompanyTask, assignTask } from '@/lib/company/service';
import { dispatchTask } from '@/lib/company/manager/delegation';
import { managerStep } from '@/lib/company/manager/service';
import { decideReassignment, evaluateReassignment, reassignTaskIfWarranted } from '@/lib/company/manager/reassign';

const prevLlm = process.env.LLM_PROVIDER;
beforeAll(() => { process.env.LLM_PROVIDER = 'stub'; });
afterAll(() => { if (prevLlm === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = prevLlm; });

type DB = ReturnType<typeof openDb>;

// A deterministic failing runtime that PERSISTS an agent_run (like the real runtime), so prior
// agent history is queryable after reassignment.
function failingRuntime(db: DB, code: string): AgentRuntime {
  return {
    list: () => [],
    run: async (id: string) => {
      const run = { id: `run-${Math.random().toString(36).slice(2)}`, agentId: id, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: false, summary: 'boom', errorCode: code, model: null, tokensIn: null, tokensOut: null, costUsd: null };
      db.agentRuns.insert(run);
      return run;
    },
    broadcast: async () => ({ id: 'b', message: '', createdAt: '', replies: [] }),
  } as unknown as AgentRuntime;
}

function makeAgent(db: DB, name: string, cap: string, tools: string[] = []): string {
  const a = createCustomAgent(db, { name, departmentId: 'dept-comms', instructions: 'Do work.', model: '', tools, enabled: true });
  db.capabilities.upsert({ id: cap, name: cap });
  db.agentCapabilities.assign(a.id, { capabilityId: cap });
  return a.id;
}

/** Two eligible agents (A pinned) + a failed-on-A task. `cap` model-only by default. */
function craftFailedOnA(db: DB, opts: { cap?: string; toolsA?: string[]; toolsB?: string[] } = {}) {
  const cap = opts.cap ?? 'research.market';
  const a = makeAgent(db, 'AgentA', cap, opts.toolsA ?? []);
  const b = makeAgent(db, 'AgentB', cap, opts.toolsB ?? []);
  const m = createMission(db, { title: 'M' });
  const task = createCompanyTask(db, m.id, { title: 'T', requiredCapabilities: [cap] });
  assignTask(db, task.id, a); // pin A so dispatch runs A
  return { missionId: m.id, taskId: task.id, a, b, cap };
}

// ── Pure decision layer ──────────────────────────────────────────────────────
describe('decideReassignment (pure)', () => {
  const base = { status: 'failed' as const, assignedAgentId: 'A', attemptCount: 1, maxAttempts: 3, safeToRepeat: true, requiresHumanAction: false };
  test('agent-specific + alternate → REASSIGN_ALLOWED to the chosen (never the failed agent)', () => {
    const d = decideReassignment({ ...base, assignedStillEligible: false, alternateEligibleIds: ['B'], chosenAgentId: 'B' });
    expect(d.decision).toBe('REASSIGN_ALLOWED');
    expect(d.toAgentId).toBe('B');
  });
  test('still-eligible agent → FAILURE_NOT_AGENT_SPECIFIC (same-agent retry)', () => {
    expect(decideReassignment({ ...base, assignedStillEligible: true, alternateEligibleIds: ['B'], chosenAgentId: 'B' }).decision).toBe('FAILURE_NOT_AGENT_SPECIFIC');
  });
  test('no alternate → NO_ALTERNATE_AGENT; chosen===failed agent → NO_ALTERNATE_AGENT (V: no force)', () => {
    expect(decideReassignment({ ...base, assignedStillEligible: false, alternateEligibleIds: [], chosenAgentId: undefined }).decision).toBe('NO_ALTERNATE_AGENT');
    expect(decideReassignment({ ...base, assignedStillEligible: false, alternateEligibleIds: ['A'], chosenAgentId: 'A' }).decision).toBe('NO_ALTERNATE_AGENT');
  });
  test('human-action / unsafe / exhausted gates come before agent-specific', () => {
    expect(decideReassignment({ ...base, requiresHumanAction: true, assignedStillEligible: false, alternateEligibleIds: ['B'], chosenAgentId: 'B' }).decision).toBe('HUMAN_ACTION_REQUIRED');
    expect(decideReassignment({ ...base, safeToRepeat: false, assignedStillEligible: false, alternateEligibleIds: ['B'], chosenAgentId: 'B' }).decision).toBe('UNSAFE_TO_REPEAT');
    expect(decideReassignment({ ...base, attemptCount: 3, assignedStillEligible: false, alternateEligibleIds: ['B'], chosenAgentId: 'B' }).decision).toBe('RETRY_EXHAUSTED');
  });
});

// ── Service + integration ────────────────────────────────────────────────────
describe('reassignment service', () => {
  test('A + D + F + H + I: agent-specific failure reassigns to B; failed agent excluded; attempt kept; history + one event', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId, a, b } = craftFailedOnA(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime(db, 'network_error') }); // attempt 1 fails on A
    expect(getCompanyTask(db, taskId)!.attemptCount).toBe(1);
    db.agentCapabilities.remove(a, 'research.market'); // A is now no longer eligible (agent-specific)

    const d = reassignTaskIfWarranted(db, taskId);
    expect(d.decision).toBe('REASSIGN_ALLOWED');
    expect(d.toAgentId).toBe(b); // D: not the failed agent A
    const t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('queued');
    expect(t.assignedAgentId).toBe(b);
    expect(t.attemptCount).toBe(1); // F: not incremented by reassignment
    expect(db.agentRuns.byAgent(a).length).toBe(1); // H: A's prior run preserved
    expect(db.companyEvents.forTask(taskId).filter((e) => e.type === 'TASK_REASSIGNED')).toHaveLength(1); // I
  });

  test('G: after reassignment the next dispatch increments the attempt exactly once and completes on B', async () => {
    const db = openDb(':memory:');
    const { taskId, a, b } = craftFailedOnA(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime(db, 'network_error') });
    db.agentCapabilities.remove(a, 'research.market');
    reassignTaskIfWarranted(db, taskId);

    await dispatchTask(db, taskId); // healthy re-dispatch on B (stub LLM → ok)
    const t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('completed');
    expect(t.assignedAgentId).toBe(b);
    expect(t.attemptCount).toBe(2); // G
    expect(db.companyArtifacts.forTask(taskId)).toHaveLength(1);
    expect(db.agentRuns.byAgent(a).length).toBe(1); // both histories present
    expect(db.agentRuns.byAgent(b).length).toBeGreaterThanOrEqual(1);
  });

  test('B + U: an alternate lacking the required capability / wired tool is NOT selected', async () => {
    const db = openDb(':memory:');
    // research.web REQUIRES the wired web.search tool. A has it; B has the capability but NO tool.
    const a = makeAgent(db, 'AgentA', 'research.web', ['web.search']);
    const b = makeAgent(db, 'AgentB', 'research.web', []); // capability-label only — no wired tool
    void b;
    const m = createMission(db, { title: 'M' });
    const task = createCompanyTask(db, m.id, { title: 'T', requiredCapabilities: ['research.web'] });
    assignTask(db, task.id, a);
    await dispatchTask(db, task.id, { runtime: failingRuntime(db, 'network_error') });
    db.customAgents.insert({ ...db.customAgents.get(a)!, tools: [] }); // A loses the tool → A ineligible too

    const d = reassignTaskIfWarranted(db, task.id);
    expect(d.decision).toBe('NO_ALTERNATE_AGENT'); // B has the label but not the wired tool → not a candidate (U: no tool fallback)
    expect(getCompanyTask(db, task.id)!.status).toBe('failed');
  });

  test('C + E: a tool-equipped alternate IS selected, deterministically', async () => {
    const db = openDb(':memory:');
    const a = makeAgent(db, 'AgentA', 'research.web', ['web.search']);
    const b = makeAgent(db, 'AgentB', 'research.web', ['web.search']);
    const c = makeAgent(db, 'AgentC', 'research.web', ['web.search']);
    void b; void c;
    const m = createMission(db, { title: 'M' });
    const task = createCompanyTask(db, m.id, { title: 'T', requiredCapabilities: ['research.web'] });
    assignTask(db, task.id, a);
    await dispatchTask(db, task.id, { runtime: failingRuntime(db, 'network_error') });
    db.agentCapabilities.remove(a, 'research.web'); // A ineligible; B and C remain (both tool-equipped)

    const first = evaluateReassignment(db, task.id);
    const second = evaluateReassignment(db, task.id);
    expect(first.decision).toBe('REASSIGN_ALLOWED');
    expect(first.toAgentId).toBeDefined();
    expect(first.toAgentId).not.toBe(a);
    expect(second.toAgentId).toBe(first.toAgentId); // E: deterministic
  });

  test('J + S: no eligible alternate → task stays failed, NO Agent Factory / new agent created', async () => {
    const db = openDb(':memory:');
    const { taskId, a } = craftFailedOnA(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime(db, 'network_error') });
    const agentsBefore = allRuntimeAgents(db).length;
    const proposalsBefore = db.companyAgentProposals.forMission(getCompanyTask(db, taskId)!.missionId).length;
    // Make BOTH A and its alternate ineligible (remove every agent's capability).
    for (const ag of db.customAgents.all()) db.agentCapabilities.remove(ag.id, 'research.market');
    void a;

    const d = reassignTaskIfWarranted(db, taskId);
    expect(d.decision).toBe('NO_ALTERNATE_AGENT');
    expect(getCompanyTask(db, taskId)!.status).toBe('failed');
    expect(allRuntimeAgents(db).length).toBe(agentsBefore); // S: no agent created
    expect(db.companyAgentProposals.forMission(getCompanyTask(db, taskId)!.missionId).length).toBe(proposalsBefore);
  });

  test('M + T: a provider timeout on a STILL-eligible agent is NOT rotated (no provider fallback)', async () => {
    const db = openDb(':memory:');
    const { taskId, a } = craftFailedOnA(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime(db, 'hermes_unavailable') }); // transient, A still eligible
    const d = reassignTaskIfWarranted(db, taskId);
    expect(d.decision).toBe('FAILURE_NOT_AGENT_SPECIFIC');
    expect(getCompanyTask(db, taskId)!.assignedAgentId).toBe(a); // unchanged — same-agent G1 retry
  });

  test('K + L + N: capability-gap / global tool-config / approval failures never reassign', async () => {
    const db = openDb(':memory:');
    for (const code of ['capability_gap', 'credential_missing', 'hermes_approval_required']) {
      const { taskId } = craftFailedOnA(db);
      await dispatchTask(db, taskId, { runtime: failingRuntime(db, code) });
      const d = reassignTaskIfWarranted(db, taskId);
      expect(d.decision).not.toBe('REASSIGN_ALLOWED');
    }
  });

  test('O: an unsafe side-effect task is never auto-reassigned', async () => {
    const db = openDb(':memory:');
    const { taskId, a } = craftFailedOnA(db, { toolsA: ['telegram'] }); // side-effect tool
    await dispatchTask(db, taskId, { runtime: failingRuntime(db, 'network_error') });
    db.agentCapabilities.remove(a, 'research.market'); // A ineligible, but repeating is UNSAFE
    const d = reassignTaskIfWarranted(db, taskId);
    expect(d.decision).toBe('UNSAFE_TO_REPEAT');
    expect(getCompanyTask(db, taskId)!.attemptCount).toBe(1);
  });

  test('P: exhausted budget blocks reassignment', async () => {
    const db = openDb(':memory:');
    const { taskId, a } = craftFailedOnA(db);
    db.companyTasks.insert({ ...getCompanyTask(db, taskId)!, maxAttempts: 1 });
    await dispatchTask(db, taskId, { runtime: failingRuntime(db, 'network_error') }); // attempt 1 → exhausted
    db.agentCapabilities.remove(a, 'research.market');
    expect(reassignTaskIfWarranted(db, taskId).decision).toBe('RETRY_EXHAUSTED');
  });

  test('Q + R: completed and workflow (unassigned) tasks are NOT applicable', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const done = createCompanyTask(db, m.id, { title: 'done' });
    db.companyTasks.insert({ ...getCompanyTask(db, done.id)!, status: 'completed' });
    expect(evaluateReassignment(db, done.id).decision).toBe('NOT_APPLICABLE'); // Q
    const wf = createCompanyTask(db, m.id, { title: 'wf' });
    db.companyTasks.insert({ ...getCompanyTask(db, wf.id)!, status: 'failed', executionKind: 'workflow' }); // no assigned agent
    expect(evaluateReassignment(db, wf.id).decision).toBe('NOT_APPLICABLE'); // R
  });
});

describe('managerStep integration (the manual scenario)', () => {
  test('managerStep reassigns an agent-specific failure to B, then dispatches + completes on B', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId, a, b } = craftFailedOnA(db);
    await dispatchTask(db, taskId, { runtime: failingRuntime(db, 'network_error') }); // attempt 1 on A fails
    expect(getCompanyTask(db, taskId)!.attemptCount).toBe(1);
    db.agentCapabilities.remove(a, 'research.market'); // A becomes unavailable/ineligible

    await managerStep(db, missionId);
    const t = getCompanyTask(db, taskId)!;
    expect(t.status).toBe('completed');
    expect(t.assignedAgentId).toBe(b); // reassigned
    expect(t.attemptCount).toBe(2); // exactly one further attempt
    expect(db.companyArtifacts.forTask(taskId)).toHaveLength(1); // one final artifact
    const types = db.companyEvents.forTask(taskId).map((e) => e.type);
    expect(types.filter((x) => x === 'TASK_REASSIGNED')).toHaveLength(1);
    expect(db.agentRuns.byAgent(a).length).toBe(1); // A history preserved
    expect(db.agentRuns.byAgent(b).length).toBeGreaterThanOrEqual(1); // B history present
  });
});

describe('V: no force-target / bypass path exists in the reassignment code', () => {
  test('reassign service references no force flag', () => {
    const src = readFileSync(path.join(process.cwd(), 'lib', 'company', 'manager', 'reassign.ts'), 'utf8');
    expect(src.toLowerCase()).not.toMatch(/force/);
    expect(src).not.toMatch(/setInterval|setTimeout|setImmediate/);
  });
});

describe('W: disabled / retired agent eligibility safety', () => {
  test('disabled custom agent (enabled: false) cannot be dispatched by normal dispatch nor selected by G3 reassignment', async () => {
    const db = openDb(':memory:');
    const cap = 'research.market';
    const a = makeAgent(db, 'AgentA', cap);
    const bDisabled = createCustomAgent(db, { name: 'AgentBDisabled', departmentId: 'dept-comms', instructions: 'Do work.', model: '', tools: [], enabled: false });
    db.capabilities.upsert({ id: cap, name: cap });
    db.agentCapabilities.assign(bDisabled.id, { capabilityId: cap });

    // Task failed on A, A becomes ineligible
    const m = createMission(db, { title: 'M' });
    const task = createCompanyTask(db, m.id, { title: 'T', requiredCapabilities: [cap] });
    assignTask(db, task.id, a);
    await dispatchTask(db, task.id, { runtime: failingRuntime(db, 'network_error') });
    db.agentCapabilities.remove(a, cap);

    // G3 reassignment must NOT select disabled Agent B
    const decision = evaluateReassignment(db, task.id);
    expect(decision.decision).toBe('NO_ALTERNATE_AGENT');
    expect(reassignTaskIfWarranted(db, task.id).decision).toBe('NO_ALTERNATE_AGENT');

    // Historical lookup of Agent B still works
    expect(getAgentById(db, bDisabled.id)).toBeDefined();
  });
});
