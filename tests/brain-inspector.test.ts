/**
 * Universal Inspector tests (Architecture V2 · F4).
 *
 * Every kind resolves canonical state into a safe typed view; unknown refs are rejected;
 * no secrets/prompts/model/tool-creds leak; actions are a CLOSED set; and privileged /
 * execution / destructive actions are `navigate` (routing to the owning surface), never a
 * direct mutation from the Inspector.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '@/lib/db';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { createCustomAgent } from '@/lib/agents/custom';
import { createMission, createCompanyTask, assignTask } from '@/lib/company/service';
import { createArtifact } from '@/lib/company/manager/artifacts';
import { promoteArtifactToBrain } from '@/lib/brain/core/promote';
import { appendEvent } from '@/lib/company/manager/events';
import { inspectEntity } from '@/lib/brain/inspector/service';
import { INSPECTOR_ACTION_IDS, type InspectorView } from '@/lib/brain/inspector/model';

type DB = ReturnType<typeof openDb>;

const G = (nodes: unknown[], edges: unknown[]): WorkflowGraph => WorkflowGraphSchema.parse({ nodes, edges });
function publishWorkflow(db: DB, id: string) {
  const g = G([
    { id: 'i', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
    { id: 'o', type: 'output', x: 0, y: 0, config: { mode: 'display' } },
  ], [{ id: 'e', source: 'i', target: 'o' }]);
  db.flowWorkflows.create({ id, name: id, graph: g });
  db.flowVersions.create({ id: `${id}-v1`, workflowId: id, version: 1, graph: g });
  db.flowWorkflows.setCurrentVersion(id, 1);
}

describe('inspectEntity — F5 Neural kinds', () => {
  it('workflow_run resolves safe fields only (never startingInput / outputs)', () => {
    const db = openDb(':memory:');
    publishWorkflow(db, 'wf-1');
    db.flowRuns.create({ id: 'run-1', workflowId: 'wf-1', workflowVersion: 1, startingInput: { text: 'SECRET INPUT' } });
    const v = inspectEntity(db, { kind: 'workflow_run', id: 'run-1' });
    expect(v.entity.kind).toBe('workflow_run');
    expect(JSON.stringify(v)).not.toMatch(/SECRET INPUT|startingInput/);
    expect(v.actions).toEqual([{ id: 'open_flows', kind: 'navigate', label: 'Open in Flows', href: '/flows' }]);
  });

  it('event resolves type/time/summary/refs safely', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'T' });
    const ev = appendEvent(db, { type: 'CAPABILITY_GAP', missionId: m.id, taskId: t.id, summary: 'Capability gap: research.web' })!;
    const v = inspectEntity(db, { kind: 'event', id: ev.id });
    expect(v.entity.kind).toBe('event');
    expect(v.sections.find((s) => s.title === 'Overview')?.rows.some((r) => r.label === 'Type')).toBe(true);
    expect(v.sections.find((s) => s.title === 'Links')?.rows.some((r) => r.value === t.id)).toBe(true);
  });
});

/** Every action id used anywhere in a view must be in the closed allow-list. */
const actionsAreClosed = (v: InspectorView) => v.actions.every((a) => (INSPECTOR_ACTION_IDS as readonly string[]).includes(a.id));

describe('inspectEntity — per kind', () => {
  it('agent resolves safe fields only (no model / prompt / secrets)', () => {
    const db = openDb(':memory:');
    const a = createCustomAgent(db, { name: 'Scout', departmentId: 'dept-tech', instructions: 'SECRET SYSTEM PROMPT', model: 'anthropic/claude-opus-5', tools: [], enabled: true });
    const v = inspectEntity(db, { kind: 'agent', id: a.id });
    expect(v.entity.label).toBe('Scout');
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/SECRET SYSTEM PROMPT/);
    expect(json).not.toMatch(/claude-opus-5/);
    expect(v.actions.map((x) => x.id)).toEqual(['open_agent', 'open_org']);
    expect(v.actions.every((x) => x.kind === 'navigate')).toBe(true);
    expect(actionsAreClosed(v)).toBe(true);
  });

  it('mission resolves task counts + blockers + artifacts', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    createCompanyTask(db, m.id, { title: 'T' });
    const v = inspectEntity(db, { kind: 'mission', id: m.id });
    expect(v.entity.kind).toBe('mission');
    expect(v.sections.some((s) => s.title === 'Tasks')).toBe(true);
    expect(v.actions).toEqual([{ id: 'open_mission', kind: 'navigate', label: 'Open in Missions', href: '/missions' }]);
  });

  it('task resolves assignment + dependencies + execution', () => {
    const db = openDb(':memory:');
    const a = createCustomAgent(db, { name: 'W', departmentId: 'dept-tech', instructions: 'x', model: '', tools: [], enabled: true });
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'T' });
    assignTask(db, t.id, a.id);
    const v = inspectEntity(db, { kind: 'task', id: t.id });
    expect(v.sections.find((s) => s.title === 'Overview')?.rows.some((r) => r.value === a.id)).toBe(true);
    expect(v.actions.every((x) => x.kind === 'navigate')).toBe(true);
  });

  it('artifact exposes provenance + a safe promote action (api, confirm)', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'T' });
    const art = createArtifact(db, { missionId: m.id, taskId: t.id, type: 'agent_result', title: 'A', content: 'body' });
    const v = inspectEntity(db, { kind: 'artifact', id: art.id });
    const promote = v.actions.find((x) => x.id === 'promote_artifact');
    expect(promote).toMatchObject({ kind: 'api', method: 'POST', confirm: true });
    expect((promote as { path: string }).path).toContain('/promote-to-brain');
    expect(actionsAreClosed(v)).toBe(true);
  });

  it('knowledge resolves provenance + a reversible archive action', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'T' });
    const art = createArtifact(db, { missionId: m.id, taskId: t.id, type: 'agent_result', title: 'A', content: 'body' });
    const { knowledge } = promoteArtifactToBrain(db, art.id);
    const v = inspectEntity(db, { kind: 'knowledge', id: knowledge.id });
    expect(v.sections.some((s) => s.title === 'Provenance')).toBe(true);
    const archive = v.actions.find((x) => x.id === 'archive_knowledge');
    expect(archive).toMatchObject({ kind: 'api', method: 'PATCH', confirm: true });
  });

  it('workflow resolves published status', () => {
    const db = openDb(':memory:');
    publishWorkflow(db, 'wf-1');
    const v = inspectEntity(db, { kind: 'workflow', id: 'wf-1' });
    expect(v.entity.status).toBe('published');
    expect(v.actions).toEqual([{ id: 'open_flows', kind: 'navigate', label: 'Open in Flows', href: '/flows' }]);
  });

  it('source resolves type + canonical ref', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'T' });
    const art = createArtifact(db, { missionId: m.id, taskId: t.id, type: 'agent_result', title: 'A', content: 'body' });
    const { source } = promoteArtifactToBrain(db, art.id);
    const v = inspectEntity(db, { kind: 'source', id: source.id });
    expect(v.entity.kind).toBe('source');
    expect(actionsAreClosed(v)).toBe(true);
  });
});

describe('inspectEntity — safety', () => {
  it('rejects an unknown kind and an unknown id', () => {
    const db = openDb(':memory:');
    expect(() => inspectEntity(db, { kind: 'galaxy', id: 'x' })).toThrow();
    expect(() => inspectEntity(db, { kind: 'mission', id: 'nope' })).toThrow(/not found/);
  });

  it('never offers a direct execute/approve/dispatch/run mutation action', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'T' });
    const art = createArtifact(db, { missionId: m.id, taskId: t.id, type: 'agent_result', title: 'A', content: 'body' });
    const views = [
      inspectEntity(db, { kind: 'mission', id: m.id }),
      inspectEntity(db, { kind: 'task', id: t.id }),
      inspectEntity(db, { kind: 'artifact', id: art.id }),
    ];
    for (const v of views) {
      for (const a of v.actions) {
        if (a.kind === 'api') {
          // the ONLY api actions allowed are the safe promote / archive
          expect(['promote_artifact', 'archive_knowledge']).toContain(a.id);
          expect(a.path).not.toMatch(/dispatch|manager-step|approve|reject|run/);
        }
      }
    }
  });
});
