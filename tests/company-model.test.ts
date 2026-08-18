/**
 * Architecture V2 · F0.2 — Company work model (pure).
 *
 * Pins the status enums + central transition validators, the terminal states,
 * the graph helpers (reachability + cycle guard reused for parent tree AND
 * dependency DAG), the mission summary, and the Zod input schemas — all without
 * SQLite.
 */
import { describe, expect, test } from 'vitest';
import {
  MISSION_STATUSES,
  COMPANY_TASK_STATUSES,
  canTransitionMission,
  canTransitionTask,
  isMissionTerminal,
  isTaskTerminal,
  reaches,
  wouldCreateCycle,
  missionTaskSummary,
  prerequisitesSatisfied,
  MissionInputSchema,
  CompanyTaskInputSchema,
  CompanyTaskUpdateSchema,
  type Edge,
} from '@/lib/company/model';

describe('status enums', () => {
  test('mission + task statuses', () => {
    expect(MISSION_STATUSES).toContain('draft');
    expect(COMPANY_TASK_STATUSES).toEqual(['queued', 'assigned', 'running', 'waiting_dependency', 'waiting_approval', 'completed', 'failed', 'cancelled']);
  });
});

describe('mission transitions', () => {
  test('valid + invalid', () => {
    expect(canTransitionMission('draft', 'active')).toBe(true);
    expect(canTransitionMission('active', 'completed')).toBe(true);
    expect(canTransitionMission('draft', 'completed')).toBe(false); // must go active first
    expect(canTransitionMission('completed', 'active')).toBe(false); // terminal
    expect(canTransitionMission('active', 'active')).toBe(true); // same = no-op
  });
  test('terminals', () => {
    expect(isMissionTerminal('completed')).toBe(true);
    expect(isMissionTerminal('active')).toBe(false);
  });
});

describe('task transitions', () => {
  test('valid + invalid', () => {
    expect(canTransitionTask('queued', 'assigned')).toBe(true);
    expect(canTransitionTask('assigned', 'running')).toBe(true);
    expect(canTransitionTask('running', 'completed')).toBe(true);
    expect(canTransitionTask('queued', 'running')).toBe(false); // must be assigned first
    expect(canTransitionTask('queued', 'completed')).toBe(false);
    expect(canTransitionTask('completed', 'running')).toBe(false); // terminal
    expect(canTransitionTask('running', 'waiting_approval')).toBe(true);
  });
  test('terminals', () => {
    expect(isTaskTerminal('failed')).toBe(true);
    expect(isTaskTerminal('running')).toBe(false);
  });
});

describe('graph helpers', () => {
  const edges: Edge[] = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ];
  test('reaches follows edges', () => {
    expect(reaches(edges, 'a', 'c')).toBe(true);
    expect(reaches(edges, 'c', 'a')).toBe(false);
    expect(reaches(edges, 'x', 'x')).toBe(true); // self
  });
  test('wouldCreateCycle: self + back-edge', () => {
    expect(wouldCreateCycle(edges, 'x', 'x')).toBe(true); // self
    expect(wouldCreateCycle(edges, 'c', 'a')).toBe(true); // c→a closes a→b→c→a
    expect(wouldCreateCycle(edges, 'a', 'd')).toBe(false); // new leaf, no cycle
  });
});

describe('mission summary + prerequisites', () => {
  test('missionTaskSummary counts by status', () => {
    const s = missionTaskSummary([{ status: 'completed' }, { status: 'completed' }, { status: 'running' }, { status: 'queued' }]);
    expect(s.total).toBe(4);
    expect(s.byStatus.completed).toBe(2);
    expect(s.byStatus.running).toBe(1);
    expect(s.byStatus.queued).toBe(1);
  });
  test('prerequisitesSatisfied only when all completed', () => {
    expect(prerequisitesSatisfied(['completed', 'completed'])).toBe(true);
    expect(prerequisitesSatisfied(['completed', 'running'])).toBe(false);
    expect(prerequisitesSatisfied([])).toBe(true);
  });
});

describe('Zod input schemas', () => {
  test('MissionInputSchema: title required, priority default normal', () => {
    expect(MissionInputSchema.parse({ title: ' Analyze market ' })).toMatchObject({ title: 'Analyze market', priority: 'normal' });
    expect(MissionInputSchema.safeParse({ title: '' }).success).toBe(false);
  });
  test('CompanyTaskInputSchema: caps normalized + malformed rejected; default []', () => {
    expect(CompanyTaskInputSchema.parse({ title: 'X', requiredCapabilities: [' Research.Web '] }).requiredCapabilities).toEqual(['research.web']);
    expect(CompanyTaskInputSchema.parse({ title: 'X' }).requiredCapabilities).toEqual([]);
    expect(CompanyTaskInputSchema.safeParse({ title: 'X', requiredCapabilities: ['notvalid'] }).success).toBe(false);
  });
  test('CompanyTaskUpdateSchema: partial + status enum', () => {
    expect(CompanyTaskUpdateSchema.parse({ status: 'running' }).status).toBe('running');
    expect(CompanyTaskUpdateSchema.safeParse({ status: 'bogus' }).success).toBe(false);
  });
});
