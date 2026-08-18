/**
 * UX Foundation U5, Part B — Agent Presence service (over the real repos).
 *
 * Verifies presence is derived from REAL run/node-run/approval state: a running
 * agent node → working; a pending approval on a run the agent participated in →
 * waiting_approval; a failed agent node → failed; no signal → idle (omitted). The
 * agent↔node relationship is resolved from the immutable version graph and never
 * guessed when it can't be resolved.
 */
import { describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { buildAgentPresence } from '@/lib/agents/presence-service';

const G = (nodes: unknown[], edges: unknown[]): WorkflowGraph => WorkflowGraphSchema.parse({ nodes, edges });

/** input → agent(node 'a' = AGENT_ID) → approval → output. */
const AGENT_ID = 'agent-x';
function seed(db: ReturnType<typeof openDb>, workflowId = 'wf') {
  const g = G(
    [
      { id: 'i', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
      { id: 'a', type: 'agent', x: 0, y: 0, config: { agentId: AGENT_ID } },
      { id: 'ap', type: 'approval', x: 0, y: 0, config: { title: 't', message: '', approveRoute: 'approve', rejectRoute: 'reject' } },
      { id: 'ok', type: 'output', x: 0, y: 0, config: { mode: 'display' } },
    ],
    [
      { id: 'e1', source: 'i', target: 'a' },
      { id: 'e2', source: 'a', target: 'ap' },
      { id: 'e3', source: 'ap', target: 'ok', sourceHandle: 'approve' },
    ],
  );
  db.flowWorkflows.create({ id: workflowId, name: 'Gmail Daily', graph: g });
  db.flowVersions.create({ id: `${workflowId}-v1`, workflowId, version: 1, graph: g });
  return g;
}
const newRun = (db: ReturnType<typeof openDb>, id: string, workflowId = 'wf') =>
  db.flowRuns.create({ id, workflowId, workflowVersion: 1, startingInput: { text: '' } });

describe('buildAgentPresence', () => {
  test('running agent node → working, with the workflow name', () => {
    const db = openDb(':memory:');
    seed(db);
    newRun(db, 'run-1');
    db.flowNodeRuns.create({ id: 'nr-1', runId: 'run-1', nodeId: 'a', nodeType: 'agent', status: 'running' });

    const p = buildAgentPresence(db).find((x) => x.agentId === AGENT_ID);
    expect(p?.state).toBe('working');
    expect(p?.workflowName).toBe('Gmail Daily');
    expect(p?.runId).toBe('run-1');
  });

  test('pending approval on a run the agent participated in → waiting_approval', () => {
    const db = openDb(':memory:');
    seed(db);
    newRun(db, 'run-1');
    // the agent already ran (succeeded), then the run paused at the gate
    db.flowNodeRuns.create({ id: 'nr-1', runId: 'run-1', nodeId: 'a', nodeType: 'agent', status: 'success' });
    db.flowApprovals.create({
      id: 'appr-1', runId: 'run-1', nodeRunId: null, workflowId: 'wf', workflowVersion: 1, nodeId: 'ap',
      title: 't', message: '', approvalRoute: 'approve', rejectionRoute: 'reject',
    });

    const p = buildAgentPresence(db).find((x) => x.agentId === AGENT_ID);
    expect(p?.state).toBe('waiting_approval');
  });

  test('failed agent node → failed', () => {
    const db = openDb(':memory:');
    seed(db);
    newRun(db, 'run-1');
    db.flowNodeRuns.create({ id: 'nr-1', runId: 'run-1', nodeId: 'a', nodeType: 'agent', status: 'failed' });

    const p = buildAgentPresence(db).find((x) => x.agentId === AGENT_ID);
    expect(p?.state).toBe('failed');
  });

  test('an agent with only a completed run (no pending gate) is idle → omitted', () => {
    const db = openDb(':memory:');
    seed(db);
    newRun(db, 'run-1');
    db.flowNodeRuns.create({ id: 'nr-1', runId: 'run-1', nodeId: 'a', nodeType: 'agent', status: 'success' });

    expect(buildAgentPresence(db)).toHaveLength(0);
  });

  test('a non-agent node failure does not fabricate an agent presence', () => {
    const db = openDb(':memory:');
    seed(db);
    newRun(db, 'run-1');
    // a tool/output node failing must not be attributed to any agent
    db.flowNodeRuns.create({ id: 'nr-1', runId: 'run-1', nodeId: 'ok', nodeType: 'output', status: 'failed' });

    expect(buildAgentPresence(db)).toHaveLength(0);
  });
});
