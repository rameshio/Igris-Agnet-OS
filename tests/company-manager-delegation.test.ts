/**
 * Architecture V2 · F1 — delegation / dispatch (over the real repos + runtimes).
 *
 * Verifies agent dispatch creates exactly one agent run + one artifact + honest
 * lifecycle, idempotent retry, workflow dispatch through the EXISTING engine
 * (published only), reconcile from a flow run, capability gap (NO agent created),
 * dependency waiting, and that outputs/ledger never leak secrets.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { createCustomAgent } from '@/lib/agents/custom';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { createMission, createCompanyTask, addTaskDependency, getCompanyTask } from '@/lib/company/service';
import { dispatchTask, reconcileTask } from '@/lib/company/manager/delegation';

const prevLlm = process.env.LLM_PROVIDER;
beforeAll(() => {
  process.env.LLM_PROVIDER = 'stub'; // custom-agent runs resolve deterministically (ok: true)
});
afterAll(() => {
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
});

type DB = ReturnType<typeof openDb>;

function agentWithCap(db: DB, name: string, cap: string): string {
  const a = createCustomAgent(db, { name, departmentId: 'dept-comms', instructions: 'Do work.', model: '', tools: [], enabled: true });
  db.capabilities.upsert({ id: cap, name: cap });
  db.agentCapabilities.assign(a.id, { capabilityId: cap });
  return a.id;
}

const G = (nodes: unknown[], edges: unknown[]): WorkflowGraph => WorkflowGraphSchema.parse({ nodes, edges });
function publishWorkflow(db: DB, id: string) {
  const g = G(
    [
      { id: 'i', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
      { id: 'o', type: 'output', x: 0, y: 0, config: { mode: 'display' } },
    ],
    [{ id: 'e', source: 'i', target: 'o' }],
  );
  db.flowWorkflows.create({ id, name: id, graph: g });
  db.flowVersions.create({ id: `${id}-v1`, workflowId: id, version: 1, graph: g });
  db.flowWorkflows.setCurrentVersion(id, 1);
}

describe('agent dispatch', () => {
  test('creates exactly one agent run + one artifact; lifecycle + events; idempotent retry', async () => {
    const db = openDb(':memory:');
    const agentId = agentWithCap(db, 'Scout', 'research.market');
    const m = createMission(db, { title: 'M' });
    const task = createCompanyTask(db, m.id, { title: 'Competitor analysis', requiredCapabilities: ['research.market'] });

    const runsBefore = db.agentRuns.recent(100).length;
    const r = await dispatchTask(db, task.id);
    expect(r.outcome).toBe('dispatched_agent');
    if (r.outcome !== 'dispatched_agent') return;
    expect(r.ok).toBe(true);

    const t = getCompanyTask(db, task.id)!;
    expect(t.status).toBe('completed');
    expect(t.assignedAgentId).toBe(agentId);
    expect(t.executionKind).toBe('agent');
    expect(t.executionRefId).toBe(r.agentRunId);
    expect(db.agentRuns.recent(100).length).toBe(runsBefore + 1); // exactly one agent run
    expect(db.companyArtifacts.forTask(task.id)).toHaveLength(1);
    expect(db.companyEvents.forTask(task.id).map((e) => e.type)).toEqual(
      expect.arrayContaining(['TASK_ASSIGNED', 'TASK_DISPATCHED', 'AGENT_STARTED', 'ARTIFACT_CREATED', 'TASK_COMPLETED']),
    );

    // Retry → already_active; no second run, no duplicate artifact.
    const again = await dispatchTask(db, task.id);
    expect(again.outcome).toBe('already_active');
    expect(db.agentRuns.recent(100).length).toBe(runsBefore + 1);
    expect(db.companyArtifacts.forTask(task.id)).toHaveLength(1);
  });
});

describe('capability gap — F1 never creates an agent (that is F2)', () => {
  test('unmatched task returns a structured gap and stays queued', async () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const task = createCompanyTask(db, m.id, { title: 'Legal review', requiredCapabilities: ['legal.canada'] });
    const agentCountBefore = allRuntimeAgents(db).length;

    const r = await dispatchTask(db, task.id);
    expect(r.outcome).toBe('capability_gap');
    if (r.outcome === 'capability_gap') expect(r.missingCapabilities).toEqual(['legal.canada']);
    expect(getCompanyTask(db, task.id)!.status).toBe('queued'); // not started
    expect(allRuntimeAgents(db).length).toBe(agentCountBefore); // NO agent created
    expect(db.companyEvents.forTask(task.id).some((e) => e.type === 'CAPABILITY_GAP')).toBe(true);
  });
});

describe('dependency gating', () => {
  test('a task with an unsatisfied prerequisite waits, never dispatches', async () => {
    const db = openDb(':memory:');
    const agentId = agentWithCap(db, 'Scout', 'research.market');
    const m = createMission(db, { title: 'M' });
    const a = createCompanyTask(db, m.id, { title: 'A', requiredCapabilities: ['research.market'] });
    const b = createCompanyTask(db, m.id, { title: 'B', requiredCapabilities: ['research.market'] });
    void agentId;
    addTaskDependency(db, b.id, a.id); // B depends on A

    const r = await dispatchTask(db, b.id);
    expect(r.outcome).toBe('waiting_dependency');
    expect(getCompanyTask(db, b.id)!.status).toBe('waiting_dependency');
  });
});

describe('workflow dispatch (existing engine, published only)', () => {
  test('dispatch starts one flow run + references it; reconcile completes on success', () => {
    const db = openDb(':memory:');
    publishWorkflow(db, 'wf');
    const m = createMission(db, { title: 'M' });
    const task = createCompanyTask(db, m.id, { title: 'Run SOP', workflowId: 'wf' });

    return dispatchTask(db, task.id).then((r) => {
      expect(r.outcome).toBe('dispatched_workflow');
      if (r.outcome !== 'dispatched_workflow') return;
      const t = getCompanyTask(db, task.id)!;
      expect(t.status).toBe('running');
      expect(t.executionKind).toBe('workflow');
      expect(t.executionRefId).toBe(r.runId);
      expect(t.runId).toBe(r.runId); // F0.2 seam filled for workflow runs
      expect(db.flowRuns.get(r.runId)).toBeTruthy(); // one real flow run
      expect(db.companyEvents.forTask(task.id).some((e) => e.type === 'WORKFLOW_STARTED')).toBe(true);

      // Simulate the engine finishing, then reconcile deterministically.
      db.flowRuns.update(r.runId, { status: 'success', endedAt: new Date().toISOString() });
      reconcileTask(db, task.id);
      expect(getCompanyTask(db, task.id)!.status).toBe('completed');
      expect(db.companyArtifacts.forTask(task.id)).toHaveLength(1);
      expect(db.companyEvents.forTask(task.id).some((e) => e.type === 'TASK_COMPLETED')).toBe(true);
    });
  });

  test('a draft-only workflow (no published version) is NEVER run', async () => {
    const db = openDb(':memory:');
    const g = G([{ id: 'i', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } }], []);
    db.flowWorkflows.create({ id: 'draftwf', name: 'draftwf', graph: g }); // created, never published
    const m = createMission(db, { title: 'M' });
    const task = createCompanyTask(db, m.id, { title: 'x', workflowId: 'draftwf' });

    const r = await dispatchTask(db, task.id);
    expect(r.outcome).toBe('capability_gap'); // workflow not published → not dispatched; no agent → gap
    if (r.outcome === 'capability_gap') expect(r.reason).toBe('no_target');
    expect(db.flowRuns.recent(50)).toHaveLength(0); // no run created from a draft
  });
});

describe('safety', () => {
  test('task/artifact/event output leaks no prompts/secrets/tool config', async () => {
    const db = openDb(':memory:');
    const agentId = agentWithCap(db, 'Scout', 'research.market');
    const m = createMission(db, { title: 'M' });
    const task = createCompanyTask(db, m.id, { title: 'T', requiredCapabilities: ['research.market'] });
    await dispatchTask(db, task.id);
    void agentId;
    const json = JSON.stringify({ task: getCompanyTask(db, task.id), events: db.companyEvents.forTask(task.id), artifacts: db.companyArtifacts.forTask(task.id).map((a) => ({ id: a.id, title: a.title, type: a.type })) });
    for (const banned of ['systemPrompt', 'instructions', 'chatTools', 'apiKey', 'authorization', 'password']) {
      expect(json).not.toContain(banned);
    }
  });
});
