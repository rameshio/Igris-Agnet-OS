/**
 * Workflow delete/archive policy (UX bug fix: "cannot delete a workflow").
 *
 * The backend decides: a history-free draft is hard-deleted; a workflow with any
 * published version or run is soft-archived so immutable versions and run/approval
 * audit records survive. Only flow_* tables are touched — never legacy agent_flows.
 */
import { describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import { removeOrArchiveWorkflow } from '@/lib/flows/workflow-admin';
import type { WorkflowGraph } from '@/lib/flows/schema';

const graph: WorkflowGraph = {
  nodes: [
    { id: 'in', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
    { id: 'out', type: 'output', x: 100, y: 0, config: { mode: 'display' } },
  ],
  edges: [{ id: 'e1', source: 'in', target: 'out', mapping: { mode: 'all' } }],
};

describe('removeOrArchiveWorkflow', () => {
  test('a history-free workflow is HARD DELETED and stays gone', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf-temp', name: 'TEMP DELETE TEST', graph });

    const out = removeOrArchiveWorkflow(db, 'wf-temp');
    expect(out).toMatchObject({ ok: true, mode: 'deleted' });
    expect(db.flowWorkflows.get('wf-temp')).toBeNull();
    // "refresh" == re-list: not present in active list.
    expect(db.flowWorkflows.all().find((w) => w.id === 'wf-temp')).toBeUndefined();
  });

  test('a workflow WITH a published version is ARCHIVED (version preserved)', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf-pub', name: 'Published', graph });
    db.flowVersions.create({ id: 'wf-pub-v1', workflowId: 'wf-pub', version: 1, graph });
    db.flowWorkflows.setCurrentVersion('wf-pub', 1);

    const out = removeOrArchiveWorkflow(db, 'wf-pub');
    expect(out).toMatchObject({ ok: true, mode: 'archived' });

    // Row + immutable version survive; only hidden from the active list.
    expect(db.flowWorkflows.get('wf-pub')).not.toBeNull();
    expect(db.flowWorkflows.get('wf-pub')?.archivedAt).toBeTruthy();
    expect(db.flowWorkflows.all().find((w) => w.id === 'wf-pub')).toBeUndefined();
    expect(db.flowWorkflows.all({ includeArchived: true }).find((w) => w.id === 'wf-pub')).toBeTruthy();
    expect(db.flowVersions.get('wf-pub', 1)?.graph.nodes).toHaveLength(2);
  });

  test('a workflow WITH run + approval history is ARCHIVED (audit preserved)', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf-run', name: 'Ran', graph });
    const run = db.flowRuns.create({ id: 'r1', workflowId: 'wf-run', workflowVersion: 1, startingInput: { text: 'hi' } });
    db.flowApprovals.create({
      id: 'ap1', runId: run.id, nodeRunId: null, workflowId: 'wf-run', workflowVersion: 1, nodeId: 'ap',
      title: 'Send it?', message: 'ok', approvalRoute: 'approve', rejectionRoute: 'reject',
    });

    const out = removeOrArchiveWorkflow(db, 'wf-run');
    expect(out).toMatchObject({ ok: true, mode: 'archived' });

    // Run history + approval audit still there.
    expect(db.flowRuns.get('r1')).not.toBeNull();
    expect(db.flowApprovals.get('ap1')).not.toBeNull();
  });

  test('deleting a nonexistent workflow reports not_found (→ 404)', () => {
    const db = openDb(':memory:');
    expect(removeOrArchiveWorkflow(db, 'nope')).toEqual({ ok: false, code: 'not_found' });
  });

  test('a bogus/injection-shaped id is treated as not_found, never executes SQL', () => {
    const db = openDb(':memory:');
    db.flowWorkflows.create({ id: 'wf-keep', name: 'Keep', graph });
    const out = removeOrArchiveWorkflow(db, "wf-keep'); DROP TABLE flow_workflows;--");
    expect(out).toEqual({ ok: false, code: 'not_found' });
    // Parameterized queries mean the real workflow (and its table) are intact.
    expect(db.flowWorkflows.get('wf-keep')).not.toBeNull();
  });

  test('does NOT touch the legacy agent_flows system', () => {
    const db = openDb(':memory:');
    const now = new Date().toISOString();
    db.agentFlows.upsert({ id: 'af1', name: 'Legacy Flow', nodes: [], edges: [], createdAt: now, updatedAt: now });
    db.flowWorkflows.create({ id: 'wf-del', name: 'Del', graph });

    removeOrArchiveWorkflow(db, 'wf-del');
    expect(db.agentFlows.get('af1')).not.toBeNull();
  });
});
