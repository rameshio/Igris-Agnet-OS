/**
 * Architecture V2 · F1 — Executive Manager service (managerStep + report).
 *
 * Verifies the bounded step (activates the mission, dispatches ≤ maxSteps),
 * deterministic mission completion (only when all non-cancelled tasks completed;
 * a failure blocks it), an accurate report (counts/blockers/capability gaps), and
 * durable execution refs across a DB re-open.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '@/lib/db';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { createCustomAgent } from '@/lib/agents/custom';
import { createMission, createCompanyTask, listTasksForMission } from '@/lib/company/service';
import { managerStep, missionReport } from '@/lib/company/manager/service';

const prevLlm = process.env.LLM_PROVIDER;
beforeAll(() => {
  process.env.LLM_PROVIDER = 'stub';
});
afterAll(() => {
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
});

type DB = ReturnType<typeof openDb>;
function agentWithCap(db: DB, name: string, cap: string, enabled = true): string {
  const a = createCustomAgent(db, { name, departmentId: 'dept-comms', instructions: 'Do work.', model: '', tools: [], enabled });
  db.capabilities.upsert({ id: cap, name: cap });
  db.agentCapabilities.assign(a.id, { capabilityId: cap });
  return a.id;
}

describe('managerStep', () => {
  test('activates the mission, dispatches agent tasks, completes deterministically', async () => {
    const db = openDb(':memory:');
    agentWithCap(db, 'Scout', 'research.web');
    const m = createMission(db, { title: 'M' });
    createCompanyTask(db, m.id, { title: 'A', requiredCapabilities: ['research.web'] });
    createCompanyTask(db, m.id, { title: 'B', requiredCapabilities: ['research.web'] });

    const res = await managerStep(db, m.id, { maxSteps: 3 });
    expect(res.mission.status).toBe('completed'); // all tasks completed → mission complete
    expect(res.report.taskCounts.completed).toBe(2);
    expect(listTasksForMission(db, m.id).every((t) => t.status === 'completed')).toBe(true);
  });

  test('is bounded by maxSteps (no runaway autonomy)', async () => {
    const db = openDb(':memory:');
    agentWithCap(db, 'Scout', 'research.web');
    const m = createMission(db, { title: 'M' });
    for (let i = 0; i < 5; i++) createCompanyTask(db, m.id, { title: `T${i}`, requiredCapabilities: ['research.web'] });

    const res = await managerStep(db, m.id, { maxSteps: 2 });
    expect(res.dispatched.length).toBeLessThanOrEqual(2);
    expect(res.mission.status).not.toBe('completed'); // work remains
  });

  test('a failed task blocks mission completion', async () => {
    const db = openDb(':memory:');
    agentWithCap(db, 'Broken', 'research.web', /* enabled */ false); // run returns ok:false
    const m = createMission(db, { title: 'M' });
    createCompanyTask(db, m.id, { title: 'A', requiredCapabilities: ['research.web'] });

    const res = await managerStep(db, m.id, { maxSteps: 3 });
    expect(res.report.taskCounts.failed).toBe(1);
    expect(res.mission.status).not.toBe('completed'); // failure blocks completion
    expect(res.report.blockers.some((b) => b.reason === 'failed')).toBe(true);
  });
});

describe('missionReport (deterministic, no LLM)', () => {
  test('accurate counts + capability-gap blocker', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    createCompanyTask(db, m.id, { title: 'Gap', requiredCapabilities: ['legal.canada'] }); // no agent

    const report = missionReport(db, m.id);
    expect(report.taskCounts.total).toBe(1);
    expect(report.taskCounts.queued).toBe(1);
    expect(report.capabilityGaps).toHaveLength(1);
    expect(report.capabilityGaps[0].missingCapabilities).toEqual(['legal.canada']);
    expect(report.blockers.some((b) => b.reason === 'capability_gap')).toBe(true);
    // safe artifact projection only (never content)
    expect(JSON.stringify(report)).not.toContain('"content"');
  });
});

describe('durability', () => {
  test('execution refs survive a DB re-open', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'igris-f1-')), 'test.db');
    const g = (WorkflowGraphSchema.parse({
      nodes: [
        { id: 'i', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
        { id: 'o', type: 'output', x: 0, y: 0, config: { mode: 'display' } },
      ],
      edges: [{ id: 'e', source: 'i', target: 'o' }],
    }) as WorkflowGraph);
    const db1 = openDb(file);
    db1.flowWorkflows.create({ id: 'wf', name: 'wf', graph: g });
    db1.flowVersions.create({ id: 'wf-v1', workflowId: 'wf', version: 1, graph: g });
    db1.flowWorkflows.setCurrentVersion('wf', 1);
    const m = createMission(db1, { title: 'M' });
    const task = createCompanyTask(db1, m.id, { title: 'Run SOP', workflowId: 'wf' });
    await managerStep(db1, m.id, { maxSteps: 1 }); // dispatches the workflow task → running

    // Re-open: the workflow task + its execution reference persist.
    const db2 = openDb(file);
    const t = listTasksForMission(db2, m.id).find((x) => x.id === task.id)!;
    expect(t.status).toBe('running');
    expect(t.executionKind).toBe('workflow');
    expect(t.executionRefId).toBeTruthy();
    expect(db2.companyEvents.forMission(m.id).some((e) => e.type === 'WORKFLOW_STARTED')).toBe(true);
  });
});
