/**
 * Architecture V2 · F1 — Executive Manager pure model + planning.
 *
 * Pins the dispatch/selection policy, mission-completion rule, safe artifact
 * projection, event/artifact/plan schemas, and the planning pipeline (schema
 * validation, server-generated ids, idempotent apply, dependency resolution).
 */
import { describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import {
  chooseDispatchTarget,
  selectAgent,
  deriveMissionComplete,
  safeArtifactSummary,
  MissionPlanSchema,
  CompanyEventInputSchema,
  CompanyArtifactInputSchema,
  type CompanyArtifact,
} from '@/lib/company/manager/model';
import { parseMissionPlan, applyMissionPlan, planMission } from '@/lib/company/manager/planning';
import { createMission, listTasksForMission } from '@/lib/company/service';

describe('dispatch policy (deterministic)', () => {
  test('published workflow wins', () => {
    expect(chooseDispatchTarget({ workflowId: 'wf', hasPublishedWorkflow: true, chosenAgentId: 'a', requiredCapabilities: [], missingCapabilities: [] })).toEqual({ kind: 'workflow', workflowId: 'wf' });
  });
  test('agent when no published workflow', () => {
    expect(chooseDispatchTarget({ workflowId: 'wf', hasPublishedWorkflow: false, chosenAgentId: 'a', requiredCapabilities: ['x.y'], missingCapabilities: [] })).toEqual({ kind: 'agent', agentId: 'a' });
  });
  test('capability gap when required caps but no agent', () => {
    expect(chooseDispatchTarget({ hasPublishedWorkflow: false, requiredCapabilities: ['legal.canada'], missingCapabilities: ['legal.canada'] })).toEqual({ kind: 'gap', reason: 'capability_gap', missingCapabilities: ['legal.canada'] });
  });
  test('no_target when nothing to run', () => {
    expect(chooseDispatchTarget({ hasPublishedWorkflow: false, requiredCapabilities: [], missingCapabilities: [] })).toEqual({ kind: 'gap', reason: 'no_target', missingCapabilities: [] });
  });
});

describe('selectAgent (capability primary, presence refines)', () => {
  test('prefers a non-busy eligible agent, else the top-ranked', () => {
    expect(selectAgent(['a', 'b', 'c'], new Set(['a']))).toBe('b'); // a busy → next
    expect(selectAgent(['a', 'b'], new Set(['a', 'b']))).toBe('a'); // all busy → top ranked
    expect(selectAgent([], new Set())).toBeNull();
  });
});

describe('deriveMissionComplete', () => {
  test('complete only when all non-cancelled tasks completed; failure blocks', () => {
    expect(deriveMissionComplete(['completed', 'completed', 'cancelled'])).toBe(true);
    expect(deriveMissionComplete(['completed', 'running'])).toBe(false);
    expect(deriveMissionComplete(['completed', 'failed'])).toBe(false); // failed blocks
    expect(deriveMissionComplete([])).toBe(false);
    expect(deriveMissionComplete(['cancelled'])).toBe(false); // nothing real done
  });
});

describe('schemas + safe projection', () => {
  test('safeArtifactSummary excludes content', () => {
    const a: CompanyArtifact = { id: 'artifact-1', missionId: 'm', taskId: 't', type: 'agent_result', title: 'T', summary: 's', content: 'SECRET-BODY', contentType: 'text/plain', createdAt: 'now' };
    const safe = safeArtifactSummary(a);
    expect(JSON.stringify(safe)).not.toContain('SECRET-BODY');
    expect(safe).not.toHaveProperty('content');
  });
  test('MissionPlanSchema rejects a malformed capability id', () => {
    expect(MissionPlanSchema.safeParse({ tasks: [{ title: 'A', requiredCapabilities: ['NotValid'] }] }).success).toBe(false);
    expect(MissionPlanSchema.safeParse({ tasks: [{ title: 'A', requiredCapabilities: ['research.web'] }] }).success).toBe(true);
  });
  test('event metadata is bounded + typed', () => {
    expect(CompanyEventInputSchema.safeParse({ type: 'TASK_CREATED', summary: 'x', metadata: { a: 1, b: 'y', c: true } }).success).toBe(true);
    expect(CompanyEventInputSchema.safeParse({ type: 'NOT_A_TYPE', summary: 'x' }).success).toBe(false);
  });
  test('artifact input requires type + title', () => {
    expect(CompanyArtifactInputSchema.safeParse({ missionId: 'm', type: 'r', title: 'T' }).success).toBe(true);
    expect(CompanyArtifactInputSchema.safeParse({ missionId: 'm', title: 'T' }).success).toBe(false);
  });
});

describe('planning', () => {
  test('parseMissionPlan: valid, bad-caps rejected, non-JSON rejected', () => {
    expect(parseMissionPlan('```json\n{"tasks":[{"title":"A","requiredCapabilities":["research.web"]}]}\n```').tasks).toHaveLength(1);
    expect(() => parseMissionPlan('{"tasks":[{"title":"A","requiredCapabilities":["BAD"]}]}')).toThrow();
    expect(() => parseMissionPlan('not json at all')).toThrow();
  });

  test('applyMissionPlan: server-generated ids, dependencies, idempotent re-apply', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'Research market' });
    const plan = MissionPlanSchema.parse({ tasks: [{ title: 'Market size', requiredCapabilities: ['research.web'] }, { title: 'Pricing', dependsOn: ['Market size'] }] });

    const created = applyMissionPlan(db, m.id, plan);
    expect(created).toHaveLength(2);
    expect(created.every((t) => t.id.startsWith('ctask-'))).toBe(true); // server ids, not LLM-supplied
    const pricing = listTasksForMission(db, m.id).find((t) => t.title === 'Pricing')!;
    expect(db.companyTaskDeps.forTask(pricing.id)).toHaveLength(1); // depends on Market size

    // re-apply the same plan → no duplicates (idempotent by title)
    const again = applyMissionPlan(db, m.id, plan);
    expect(again).toHaveLength(0);
    expect(listTasksForMission(db, m.id)).toHaveLength(2);
  });

  test('planMission with an injected planner activates the mission + emits MISSION_PLANNED', async () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const planner = async () => JSON.stringify({ tasks: [{ title: 'A', requiredCapabilities: ['research.web'] }, { title: 'B', dependsOn: ['A'] }] });
    const { tasks } = await planMission(db, m.id, { planner });
    expect(tasks).toHaveLength(2);
    expect(db.companyMissions.get(m.id)!.status).toBe('active'); // draft → active on plan
    expect(db.companyEvents.forMission(m.id).some((e) => e.type === 'MISSION_PLANNED')).toBe(true);
    expect(db.companyEvents.forMission(m.id).filter((e) => e.type === 'TASK_CREATED')).toHaveLength(2);
  });
});
