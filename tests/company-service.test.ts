/**
 * Architecture V2 · F0.2 — Company work service (over the real repos).
 *
 * Verifies Mission/Task creation + validation, guarded transitions, parent +
 * dependency rules (same-mission, no self, no cycle), F0.1 capability
 * eligibility + compat-checked manual assignment, the workflow reference seam
 * (validated, never run), that the existing `agent_tasks` kanban is never
 * touched, and that outputs leak nothing sensitive. Additive schema is idempotent.
 */
import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '@/lib/db';
import { createCustomAgent } from '@/lib/agents/custom';
import {
  createMission,
  getMission,
  listMissions,
  updateMission,
  createCompanyTask,
  updateCompanyTask,
  listTasksForMission,
  assignTask,
  setTaskCapabilities,
  getEligibleAgentsForTask,
  addTaskDependency,
  getTaskDependencies,
  missionSummary,
  CompanyError,
} from '@/lib/company/service';

type DB = ReturnType<typeof openDb>;

function agentWithCaps(db: DB, name: string, caps: string[]): string {
  const a = createCustomAgent(db, { name, departmentId: 'dept-comms', instructions: 'Do work.', model: '', tools: [], enabled: true });
  for (const c of caps) {
    db.capabilities.upsert({ id: c, name: c });
    db.agentCapabilities.assign(a.id, { capabilityId: c });
  }
  return a.id;
}

describe('missions', () => {
  test('create/get/list + guarded status transitions + timestamps', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'Research accounting-firm market' });
    expect(m.status).toBe('draft');
    expect(m.priority).toBe('normal');
    expect(getMission(db, m.id)?.title).toBe('Research accounting-firm market');
    expect(listMissions(db).map((x) => x.id)).toContain(m.id);

    const active = updateMission(db, m.id, { status: 'active' });
    expect(active.status).toBe('active');
    expect(active.startedAt).toBeTruthy();
    const done = updateMission(db, m.id, { status: 'completed' });
    expect(done.completedAt).toBeTruthy();

    // invalid transition + unknown mission
    const fresh = createMission(db, { title: 'X' });
    expect(() => updateMission(db, fresh.id, { status: 'completed' })).toThrow(CompanyError); // draft→completed
    expect(() => updateMission(db, 'nope', { status: 'active' })).toThrow(/not found/);
  });
});

describe('company tasks', () => {
  test('create under mission; missing mission + parent rules', () => {
    const db = openDb(':memory:');
    const m1 = createMission(db, { title: 'M1' });
    const m2 = createMission(db, { title: 'M2' });
    const t1 = createCompanyTask(db, m1.id, { title: 'Market size' });
    expect(t1.status).toBe('queued');
    expect(listTasksForMission(db, m1.id).map((t) => t.id)).toEqual([t1.id]);

    expect(() => createCompanyTask(db, 'ghost', { title: 'x' })).toThrow(/mission not found/);

    // parent in same mission accepted; cross-mission parent rejected
    const child = createCompanyTask(db, m1.id, { title: 'Sub', parentTaskId: t1.id });
    expect(child.parentTaskId).toBe(t1.id);
    expect(() => createCompanyTask(db, m2.id, { title: 'bad', parentTaskId: t1.id })).toThrow(/different mission/);
  });

  test('reparent: self + cycle rejected', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const a = createCompanyTask(db, m.id, { title: 'A' });
    const b = createCompanyTask(db, m.id, { title: 'B', parentTaskId: a.id }); // B child of A
    expect(() => updateCompanyTask(db, a.id, { parentTaskId: a.id })).toThrow(/cycle/); // self
    expect(() => updateCompanyTask(db, a.id, { parentTaskId: b.id })).toThrow(/cycle/); // A under B closes A→B→A
  });

  test('guarded status transitions', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'T' });
    expect(() => updateCompanyTask(db, t.id, { status: 'completed' })).toThrow(/invalid task transition/); // queued→completed
    const assigned = updateCompanyTask(db, t.id, { status: 'assigned' });
    expect(assigned.status).toBe('assigned');
    const running = updateCompanyTask(db, t.id, { status: 'running' });
    expect(running.startedAt).toBeTruthy();
  });

  test('workflow reference is validated but never run', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf', name: 'WF', graph: { nodes: [], edges: [] } });
    const m = createMission(db, { title: 'M' });
    const ok = createCompanyTask(db, m.id, { title: 'via SOP', workflowId: 'wf' });
    expect(ok.workflowId).toBe('wf');
    expect(ok.runId).toBeUndefined(); // setting a workflow never creates a run
    expect(() => createCompanyTask(db, m.id, { title: 'bad', workflowId: 'ghost' })).toThrow(/unknown workflow/);
  });
});

describe('dependencies', () => {
  test('add / idempotent / self / cross-mission / cycle / prerequisite helper', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const other = createMission(db, { title: 'Other' });
    const a = createCompanyTask(db, m.id, { title: 'A' });
    const b = createCompanyTask(db, m.id, { title: 'B' });
    const x = createCompanyTask(db, other.id, { title: 'X' });

    addTaskDependency(db, b.id, a.id); // B depends on A
    addTaskDependency(db, b.id, a.id); // idempotent
    expect(db.companyTaskDeps.forTask(b.id)).toHaveLength(1);

    expect(() => addTaskDependency(db, a.id, a.id)).toThrow(/itself/);
    expect(() => addTaskDependency(db, b.id, x.id)).toThrow(/cross-mission/);
    expect(() => addTaskDependency(db, a.id, b.id)).toThrow(/cycle/); // A dep B closes B→A→B

    // prerequisite helper: B not satisfied until A completed
    expect(getTaskDependencies(db, b.id).satisfied).toBe(false);
    updateCompanyTask(db, a.id, { status: 'assigned' });
    updateCompanyTask(db, a.id, { status: 'running' });
    updateCompanyTask(db, a.id, { status: 'completed' });
    expect(getTaskDependencies(db, b.id).satisfied).toBe(true);
  });
});

describe('capabilities + assignment (F0.1 integration)', () => {
  test('eligible resolution + compat-checked manual assignment', () => {
    const db = openDb(':memory:');
    const able = agentWithCaps(db, 'Scout', ['research.web']);
    const unable = agentWithCaps(db, 'Clerk', []);
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'Competitor analysis' });

    setTaskCapabilities(db, t.id, ['research.web']);
    expect(getEligibleAgentsForTask(db, t.id).map((a) => a.agentId)).toEqual([able]);

    // compatible assign succeeds and moves queued→assigned
    const assigned = assignTask(db, t.id, able);
    expect(assigned.assignedAgentId).toBe(able);
    expect(assigned.status).toBe('assigned');

    // incompatible assign is REJECTED (capability metadata stays meaningful)
    expect(() => assignTask(db, t.id, unable)).toThrow(/lacks the required capabilities/);
    expect(() => assignTask(db, t.id, 'ghost')).toThrow(/unknown agent/);

    // a task with no required capabilities has no capability-based eligibility
    const open = createCompanyTask(db, m.id, { title: 'Open' });
    expect(getEligibleAgentsForTask(db, open.id)).toEqual([]);
  });
});

describe('separation, security, idempotency', () => {
  test('company operations never touch agent_tasks', () => {
    const db = openDb(':memory:');
    const before = db.agentTasks.all().length;
    const m = createMission(db, { title: 'M' });
    createCompanyTask(db, m.id, { title: 'T' });
    expect(db.agentTasks.all().length).toBe(before); // untouched
  });

  test('outputs carry no prompts/secrets/tool config', () => {
    const db = openDb(':memory:');
    const able = agentWithCaps(db, 'Scout', ['research.web']);
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'T', requiredCapabilities: ['research.web'] });
    const json = JSON.stringify({ mission: getMission(db, m.id), task: t, eligible: getEligibleAgentsForTask(db, t.id), summary: missionSummary(db, m.id), assign: assignTask(db, t.id, able) });
    for (const banned of ['systemPrompt', 'instructions', 'chatTools', 'tools', 'token', 'apiKey', 'secret']) {
      expect(json).not.toContain(banned);
    }
  });

  test('additive schema is idempotent + existing data preserved on re-open', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'igris-company-')), 'test.db');
    const db1 = openDb(file);
    const m = createMission(db1, { title: 'Persisted' });
    createCompanyTask(db1, m.id, { title: 'T' });
    const db2 = openDb(file); // re-runs CREATE TABLE IF NOT EXISTS — no error
    expect(listMissions(db2).map((x) => x.id)).toContain(m.id);
    expect(listTasksForMission(db2, m.id)).toHaveLength(1);
  });
});
