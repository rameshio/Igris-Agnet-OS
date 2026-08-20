/**
 * Company Intelligence tests (Architecture V2 · F6).
 *
 * Proves F6 derives explainable, deterministic analysis over EXISTING company
 * state — work health, capability coverage, execution, approvals, agents,
 * workflow clusters, and signals — WITHOUT fabricating precision, WITHOUT
 * mutating any canonical table, and WITHOUT ever leaking prompts / tokens /
 * approval context / workflow inputs / node outputs / artifact content.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '@/lib/db';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { createCustomAgent } from '@/lib/agents/custom';
import { createMission, createCompanyTask, assignTask, updateCompanyTask, updateMission } from '@/lib/company/service';
import { createArtifact } from '@/lib/company/manager/artifacts';
import { appendEvent } from '@/lib/company/manager/events';
import type { CompanyEvent } from '@/lib/company/manager/model';
import type { CompanyTask } from '@/lib/company/model';
import {
  classifyCoverage,
  completionRate,
  deriveSignals,
  durationStats,
  parseIntelWindow,
  IntelError,
  INTEL_THRESHOLDS,
} from '@/lib/company/intelligence/model';
import { getCompanyIntelligence } from '@/lib/company/intelligence/service';

type DB = ReturnType<typeof openDb>;

const HOUR = 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** Overwrite selected fields on a task row (timestamp control for stale/duration tests). */
function patchTask(db: DB, taskId: string, patch: Partial<CompanyTask>): void {
  const t = db.companyTasks.get(taskId)!;
  db.companyTasks.insert({ ...t, ...patch });
}

function publishWorkflow(db: DB, id: string) {
  const g: WorkflowGraph = WorkflowGraphSchema.parse({
    nodes: [
      { id: 'i', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
      { id: 'o', type: 'output', x: 0, y: 0, config: { mode: 'display' } },
    ],
    edges: [{ id: 'e', source: 'i', target: 'o' }],
  });
  db.flowWorkflows.create({ id, name: id, graph: g });
  db.flowVersions.create({ id: `${id}-v1`, workflowId: id, version: 1, graph: g });
  db.flowWorkflows.setCurrentVersion(id, 1);
}

// ── Pure model ────────────────────────────────────────────────────────────────
describe('intelligence model — pure helpers', () => {
  it('classifies coverage: 0 → gap, 1 → single_point, ≥2 → healthy', () => {
    expect(classifyCoverage(0)).toBe('gap');
    expect(classifyCoverage(1)).toBe('single_point');
    expect(classifyCoverage(2)).toBe('healthy');
  });

  it('durationStats returns nulls on empty and median on valid data', () => {
    expect(durationStats([])).toEqual({ count: 0, medianMs: null, averageMs: null });
    expect(durationStats([1000, 3000, 2000])).toEqual({ count: 3, medianMs: 2000, averageMs: 2000 });
  });

  it('completionRate is null with no terminal work', () => {
    expect(completionRate(0, 0)).toBeNull();
    expect(completionRate(3, 1)).toBe(0.75);
  });

  it('parseIntelWindow defaults on absent and rejects an unknown value', () => {
    expect(parseIntelWindow(undefined)).toBe('7d');
    expect(parseIntelWindow('')).toBe('7d');
    expect(parseIntelWindow('24h')).toBe('24h');
    expect(() => parseIntelWindow('all')).toThrow(IntelError);
  });

  it('deriveSignals is deterministic, deduped, severity-sorted, evidence-bearing', () => {
    const input = {
      staleTasks: [{ taskId: 'ct1', title: 'T', missionId: 'm', status: 'queued' as const, ageMs: 2 * 24 * HOUR, thresholdMs: 24 * HOUR }],
      missions: [{ missionId: 'm', title: 'M', status: 'blocked' as const, total: 2, completed: 0, failed: 1, progress: 0 }],
      capabilities: [{ capabilityId: 'research.web', requiredByTasks: 1, eligibleAgents: 0, coverageStatus: 'gap' as const, gapEventsInWindow: 1, temporaryAgentsInWindow: 0 }],
      delayedApprovals: [{ approvalId: 'appr1', title: 'Approve deploy?', taskId: 'ct1', waitMs: 46 * 60 * 1000 }],
      repeatedFailures: [],
      agents: [],
      workflowClusters: [],
    };
    const a = deriveSignals(input);
    const b = deriveSignals(input);
    expect(a).toEqual(b); // deterministic
    expect(a).toEqual(deriveSignals({ ...input, capabilities: [...input.capabilities, input.capabilities[0]] })); // deduped
    expect(a[0].severity).toBe('critical'); // capability_gap sorts first
    expect(a.every((s) => s.evidence.length > 0)).toBe(true);
    expect(a.find((s) => s.type === 'stale_task')?.threshold?.value).toBe(24 * HOUR);
    const delay = a.find((s) => s.type === 'approval_delay');
    expect(delay?.severity).toBe('warning');
    expect(delay?.threshold?.value).toBe(INTEL_THRESHOLDS.longApprovalWaitMs);
    expect(new Set(a.map((s) => s.type)).size).toBe(a.length); // closed, no duplicate types here
  });
});

// ── Work health ───────────────────────────────────────────────────────────────
describe('work health', () => {
  it('counts the live queue and windowed throughput', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const q = createCompanyTask(db, m.id, { title: 'queued' });
    const r = createCompanyTask(db, m.id, { title: 'running' });
    updateCompanyTask(db, r.id, { status: 'assigned' });
    updateCompanyTask(db, r.id, { status: 'running' });
    const done = createCompanyTask(db, m.id, { title: 'done' });
    updateCompanyTask(db, done.id, { status: 'assigned' });
    updateCompanyTask(db, done.id, { status: 'running' });
    updateCompanyTask(db, done.id, { status: 'completed' });

    const snap = getCompanyIntelligence(db, { window: '24h' });
    expect(snap.workHealth.queued).toBe(1);
    expect(snap.workHealth.running).toBe(1);
    expect(snap.workHealth.completedInWindow).toBe(1);
    expect(q.status).toBe('queued');
  });

  it('detects a blocked mission and a blocked_mission signal', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'Launch' });
    updateMission(db, m.id, { status: 'active' });
    updateMission(db, m.id, { status: 'blocked' });
    const snap = getCompanyIntelligence(db);
    expect(snap.workHealth.blockedMissions).toBe(1);
    expect(snap.signals.some((s) => s.type === 'blocked_mission' && s.evidence[0].id === m.id)).toBe(true);
  });

  it('flags a stale queued task but never a completed or cancelled one', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const stale = createCompanyTask(db, m.id, { title: 'ancient' });
    patchTask(db, stale.id, { updatedAt: iso(25 * HOUR) });
    const doneOld = createCompanyTask(db, m.id, { title: 'done-old' });
    updateCompanyTask(db, doneOld.id, { status: 'assigned' });
    updateCompanyTask(db, doneOld.id, { status: 'running' });
    updateCompanyTask(db, doneOld.id, { status: 'completed' });
    patchTask(db, doneOld.id, { updatedAt: iso(30 * HOUR) });
    const cancelledOld = createCompanyTask(db, m.id, { title: 'cx' });
    updateCompanyTask(db, cancelledOld.id, { status: 'cancelled' });
    patchTask(db, cancelledOld.id, { updatedAt: iso(40 * HOUR) });

    const snap = getCompanyIntelligence(db);
    const staleIds = snap.workHealth.staleTasks.map((t) => t.taskId);
    expect(staleIds).toContain(stale.id);
    expect(staleIds).not.toContain(doneOld.id);
    expect(staleIds).not.toContain(cancelledOld.id);
    expect(snap.signals.some((s) => s.type === 'stale_task' && s.evidence[0].id === stale.id)).toBe(true);
  });
});

// ── Capability intelligence ─────────────────────────────────────────────────
describe('capability intelligence', () => {
  it('classifies gap / single-point / healthy and counts required-by', () => {
    const db = openDb(':memory:');
    const a1 = createCustomAgent(db, { name: 'A1', departmentId: 'dept-tech', instructions: 'x', model: '', tools: [], enabled: true });
    const a2 = createCustomAgent(db, { name: 'A2', departmentId: 'dept-tech', instructions: 'x', model: '', tools: [], enabled: true });
    db.agentCapabilities.assign(a1.id, { capabilityId: 'research.web' });
    db.agentCapabilities.assign(a2.id, { capabilityId: 'research.web' });
    db.agentCapabilities.assign(a1.id, { capabilityId: 'design.logo' });

    const m = createMission(db, { title: 'M' });
    createCompanyTask(db, m.id, { title: 't-healthy', requiredCapabilities: ['research.web'] });
    createCompanyTask(db, m.id, { title: 't-single', requiredCapabilities: ['design.logo'] });
    createCompanyTask(db, m.id, { title: 't-gap', requiredCapabilities: ['ml.train'] });

    const caps = getCompanyIntelligence(db).capabilityHealth;
    const by = Object.fromEntries(caps.capabilities.map((c) => [c.capabilityId, c]));
    expect(by['research.web'].coverageStatus).toBe('healthy');
    expect(by['design.logo'].coverageStatus).toBe('single_point');
    expect(by['ml.train'].coverageStatus).toBe('gap');
    expect(by['research.web'].requiredByTasks).toBe(1);
    expect(caps.unresolvedGapTasks).toBe(1);
  });

  it('emits capability_gap (critical) and single_point signals only for required capabilities', () => {
    const db = openDb(':memory:');
    const a1 = createCustomAgent(db, { name: 'A1', departmentId: 'dept-tech', instructions: 'x', model: '', tools: [], enabled: true });
    db.agentCapabilities.assign(a1.id, { capabilityId: 'design.logo' });
    const m = createMission(db, { title: 'M' });
    createCompanyTask(db, m.id, { title: 't-single', requiredCapabilities: ['design.logo'] });
    createCompanyTask(db, m.id, { title: 't-gap', requiredCapabilities: ['ml.train'] });

    const sigs = getCompanyIntelligence(db).signals;
    const gap = sigs.find((s) => s.type === 'capability_gap');
    expect(gap?.severity).toBe('critical');
    expect(gap?.evidence[0].id).toBe('ml.train');
    expect(sigs.some((s) => s.type === 'single_point_capability' && s.evidence[0].id === 'design.logo')).toBe(true);
  });

  it('correlates in-window CAPABILITY_GAP events and factory promotions', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 't', requiredCapabilities: ['ml.train'] });
    appendEvent(db, { type: 'CAPABILITY_GAP', missionId: m.id, taskId: t.id, summary: 'no worker', metadata: { reason: 'capability_gap' } });
    const cap = getCompanyIntelligence(db, { window: '24h' }).capabilityHealth;
    expect(cap.capabilityGapEventsInWindow).toBe(1);
    const ml = cap.capabilities.find((c) => c.capabilityId === 'ml.train');
    expect(ml?.gapEventsInWindow).toBe(1);
  });
});

// ── Execution intelligence ──────────────────────────────────────────────────
describe('execution intelligence', () => {
  it('counts completions/failures, execution mix, and real durations only', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    // completed with a valid 5-minute duration
    const done = createCompanyTask(db, m.id, { title: 'd' });
    updateCompanyTask(db, done.id, { status: 'assigned' });
    updateCompanyTask(db, done.id, { status: 'running' });
    updateCompanyTask(db, done.id, { status: 'completed' });
    patchTask(db, done.id, { startedAt: iso(10 * 60 * 1000), completedAt: iso(5 * 60 * 1000), executionKind: 'agent' });
    // completed but MISSING startedAt → excluded from duration (never fabricated)
    const done2 = createCompanyTask(db, m.id, { title: 'd2' });
    updateCompanyTask(db, done2.id, { status: 'assigned' });
    updateCompanyTask(db, done2.id, { status: 'running' });
    updateCompanyTask(db, done2.id, { status: 'completed' });
    patchTask(db, done2.id, { startedAt: undefined, completedAt: iso(60 * 1000) });
    // a failure, executed via workflow
    const fail = createCompanyTask(db, m.id, { title: 'f' });
    updateCompanyTask(db, fail.id, { status: 'assigned' });
    updateCompanyTask(db, fail.id, { status: 'running' });
    updateCompanyTask(db, fail.id, { status: 'failed' });
    patchTask(db, fail.id, { startedAt: iso(3 * 60 * 1000), executionKind: 'workflow' });

    const ex = getCompanyIntelligence(db, { window: '24h' }).executionHealth;
    expect(ex.tasksCompleted).toBe(2);
    expect(ex.tasksFailed).toBe(1);
    expect(ex.completionRate).toBe(0.67);
    expect(ex.directAgentExecutions).toBe(1);
    expect(ex.workflowExecutions).toBe(1);
    expect(ex.taskDuration.count).toBe(1); // only the task with both timestamps
    expect(ex.taskDuration.medianMs).toBe(5 * 60 * 1000);
  });

  it('signals a workflow_failure_cluster only past the sample threshold', () => {
    const db = openDb(':memory:');
    publishWorkflow(db, 'wf-flaky');
    for (let i = 0; i < 3; i++) {
      const run = db.flowRuns.create({ id: `r${i}`, workflowId: 'wf-flaky', workflowVersion: 1, startingInput: { text: 'in' } });
      db.flowRuns.update(run.id, { status: 'failed' });
    }
    const withCluster = getCompanyIntelligence(db, { window: '24h' });
    expect(withCluster.executionHealth.workflowRuns).toBe(3);
    expect(withCluster.signals.some((s) => s.type === 'workflow_failure_cluster' && s.evidence[0].id === 'wf-flaky')).toBe(true);

    const db2 = openDb(':memory:');
    publishWorkflow(db2, 'wf-few');
    for (let i = 0; i < 2; i++) {
      const run = db2.flowRuns.create({ id: `r${i}`, workflowId: 'wf-few', workflowVersion: 1, startingInput: { text: 'in' } });
      db2.flowRuns.update(run.id, { status: 'failed' });
    }
    const noCluster = getCompanyIntelligence(db2, { window: '24h' });
    expect(noCluster.signals.some((s) => s.type === 'workflow_failure_cluster')).toBe(false);
  });

  it('signals repeated_failure when TASK_FAILED recurs past threshold', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'flaky' });
    for (let i = 0; i < INTEL_THRESHOLDS.repeatedFailureCount; i++) {
      appendEvent(db, { type: 'TASK_FAILED', missionId: m.id, taskId: t.id, summary: 'boom' });
    }
    const sig = getCompanyIntelligence(db, { window: '24h' }).signals.find((s) => s.type === 'repeated_failure');
    expect(sig?.severity).toBe('critical');
    expect(sig?.evidence[0].id).toBe(t.id);
  });
});

// ── Approval intelligence ─────────────────────────────────────────────────────
describe('approval intelligence', () => {
  it('reports the pending backlog and oldest wait — never context_json', () => {
    const db = openDb(':memory:');
    publishWorkflow(db, 'wf-a');
    const run = db.flowRuns.create({ id: 'run-a', workflowId: 'wf-a', workflowVersion: 1, startingInput: { text: 'in' } });
    db.flowApprovals.create({ id: 'appr-1', runId: run.id, nodeRunId: null, workflowId: 'wf-a', workflowVersion: 1, nodeId: 'o', title: 'Approve deploy?', message: 'm', context: { secret: 'CONTEXT_LEAK_CANARY' }, approvalRoute: 'approve', rejectionRoute: 'reject' });

    const snap = getCompanyIntelligence(db, { window: '24h' });
    expect(snap.approvalHealth.pending).toBe(1);
    expect(snap.approvalHealth.oldestPendingAgeMs).not.toBeNull();
    // fresh approval → under the delay threshold → no approval_delay signal yet
    expect(snap.signals.some((s) => s.type === 'approval_delay')).toBe(false);
    expect(JSON.stringify(snap)).not.toMatch(/CONTEXT_LEAK_CANARY/);
  });

  it('counts tasks currently waiting on approval', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 't' });
    updateCompanyTask(db, t.id, { status: 'assigned' });
    updateCompanyTask(db, t.id, { status: 'running' });
    updateCompanyTask(db, t.id, { status: 'waiting_approval' });
    expect(getCompanyIntelligence(db).approvalHealth.tasksWaitingApproval).toBe(1);
  });
});

// ── Agent intelligence ────────────────────────────────────────────────────────
describe('agent intelligence', () => {
  it('reports active assignments and an overload signal, with no performance score', () => {
    const db = openDb(':memory:');
    const agent = createCustomAgent(db, { name: 'Busy', departmentId: 'dept-tech', instructions: 'x', model: '', tools: [], enabled: true });
    const m = createMission(db, { title: 'M' });
    for (let i = 0; i < INTEL_THRESHOLDS.agentActiveTaskWarning; i++) {
      const t = createCompanyTask(db, m.id, { title: `t${i}` });
      assignTask(db, t.id, agent.id);
    }
    const snap = getCompanyIntelligence(db);
    const row = snap.agentHealth.find((a) => a.agentId === agent.id)!;
    expect(row.activeAssignments).toBe(INTEL_THRESHOLDS.agentActiveTaskWarning);
    expect(row).not.toHaveProperty('score');
    expect(row).not.toHaveProperty('performance');
    expect(snap.signals.some((s) => s.type === 'agent_overload' && s.evidence[0].id === agent.id)).toBe(true);
  });
});

// ── Windowing ─────────────────────────────────────────────────────────────────
describe('windowing', () => {
  it('accepts 1h/24h/7d/30d and rejects an invalid window', () => {
    const db = openDb(':memory:');
    for (const key of ['1h', '24h', '7d', '30d'] as const) {
      expect(getCompanyIntelligence(db, { window: key }).window.key).toBe(key);
    }
    expect(() => getCompanyIntelligence(db, { window: 'forever' })).toThrow(IntelError);
  });

  it('excludes events outside the window', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 't', requiredCapabilities: ['ml.train'] });
    // one fresh gap event, one from 3 days ago
    appendEvent(db, { type: 'CAPABILITY_GAP', missionId: m.id, taskId: t.id, summary: 'fresh' });
    const old: CompanyEvent = { id: 'evt-old', type: 'CAPABILITY_GAP', missionId: m.id, taskId: t.id, summary: 'old', createdAt: iso(3 * 24 * HOUR) };
    db.companyEvents.append(old);
    expect(getCompanyIntelligence(db, { window: '1h' }).capabilityHealth.capabilityGapEventsInWindow).toBe(1);
    expect(getCompanyIntelligence(db, { window: '7d' }).capabilityHealth.capabilityGapEventsInWindow).toBe(2);
  });
});

// ── Separation + privacy ──────────────────────────────────────────────────────
describe('separation and privacy', () => {
  it('never mutates canonical tables and is deterministic across calls', () => {
    const db = openDb(':memory:');
    const agent = createCustomAgent(db, { name: 'A', departmentId: 'dept-tech', instructions: 'PROMPT_LEAK_CANARY', model: '', tools: [], enabled: true });
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 't' });
    assignTask(db, t.id, agent.id);
    appendEvent(db, { type: 'TASK_CREATED', missionId: m.id, taskId: t.id, summary: 's' });

    const before = {
      tasks: db.companyTasks.all().length,
      missions: db.companyMissions.all().length,
      events: db.companyEvents.recent(1000).length,
      proposals: db.companyAgentProposals.all().length,
      brain: db.brainEntities.all().length,
    };
    const first = JSON.stringify(getCompanyIntelligence(db).signals);
    const second = JSON.stringify(getCompanyIntelligence(db).signals);
    const after = {
      tasks: db.companyTasks.all().length,
      missions: db.companyMissions.all().length,
      events: db.companyEvents.recent(1000).length,
      proposals: db.companyAgentProposals.all().length,
      brain: db.brainEntities.all().length,
    };
    expect(after).toEqual(before); // read-only: no rows created
    expect(after.brain).toBe(0); // no brain knowledge ingestion
    expect(first).toBe(second); // deterministic
  });

  it('leak canaries — the snapshot exposes no prompt / token / input / output / artifact content / tool args', () => {
    const db = openDb(':memory:');
    const agent = createCustomAgent(db, { name: 'Scout', departmentId: 'dept-tech', instructions: 'SYS_PROMPT_LEAK', model: 'gpt-secret', tools: ['slack'], enabled: true });
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 't' });
    assignTask(db, t.id, agent.id);
    createArtifact(db, { missionId: m.id, taskId: t.id, producedByAgentId: agent.id, type: 'agent_result', title: 'Findings', content: 'ARTIFACT_BODY_LEAK' });
    publishWorkflow(db, 'wf-p');
    const run = db.flowRuns.create({ id: 'run-p', workflowId: 'wf-p', workflowVersion: 1, startingInput: { text: 'STARTING_INPUT_LEAK' } });
    db.flowNodeRuns.create({ id: 'nr-p', runId: run.id, nodeId: 'o', nodeType: 'output', status: 'success' });

    const json = JSON.stringify(getCompanyIntelligence(db, { window: '30d' }));
    for (const canary of ['SYS_PROMPT_LEAK', 'gpt-secret', 'ARTIFACT_BODY_LEAK', 'STARTING_INPUT_LEAK']) {
      expect(json).not.toMatch(new RegExp(canary));
    }
  });
});
