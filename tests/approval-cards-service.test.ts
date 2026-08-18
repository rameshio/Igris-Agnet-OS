/**
 * UX Foundation U5, Part A — Approval Decision Cards service (over the real repos).
 *
 * Verifies the projection reads pending + resolved rows, resolves the workflow
 * name + risk from the immutable version graph, and NEVER leaks context_json.
 */
import { describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import { WorkflowGraphSchema, type WorkflowGraph } from '@/lib/flows/schema';
import { buildApprovalCards } from '@/lib/flows/approval-cards';

const G = (nodes: unknown[], edges: unknown[]): WorkflowGraph => WorkflowGraphSchema.parse({ nodes, edges });

/** input → agent → approval → (approve) notify-out / (reject) display-out. */
function seedGraph(db: ReturnType<typeof openDb>, workflowId: string) {
  const g = G(
    [
      { id: 'i', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } },
      { id: 'a', type: 'agent', x: 0, y: 0, config: { agentId: 'a1' } },
      { id: 'ap', type: 'approval', x: 0, y: 0, config: { title: 'Send?', message: '', approveRoute: 'approve', rejectRoute: 'reject' } },
      { id: 'sent', type: 'output', x: 0, y: 0, config: { mode: 'notify' } },
      { id: 'no', type: 'output', x: 0, y: 0, config: { mode: 'display' } },
    ],
    [
      { id: 'e1', source: 'i', target: 'a' },
      { id: 'e2', source: 'a', target: 'ap' },
      { id: 'e3', source: 'ap', target: 'sent', sourceHandle: 'approve' },
      { id: 'e4', source: 'ap', target: 'no', sourceHandle: 'reject' },
    ],
  );
  db.flowWorkflows.create({ id: workflowId, name: 'Gmail Daily', graph: g });
  db.flowVersions.create({ id: `${workflowId}-v1`, workflowId, version: 1, graph: g });
  db.flowWorkflows.setCurrentVersion(workflowId, 1);
}

function makeApproval(db: ReturnType<typeof openDb>, id: string, workflowId: string, runId: string) {
  db.flowRuns.create({ id: runId, workflowId, workflowVersion: 1, startingInput: { text: '' } });
  return db.flowApprovals.create({
    id,
    runId,
    nodeRunId: null,
    workflowId,
    workflowVersion: 1,
    nodeId: 'ap',
    title: 'Send?',
    message: 'Send the drafted reply',
    context: { secretLookingBlob: 'DO-NOT-LEAK', inputText: 'hi' },
    approvalRoute: 'approve',
    rejectionRoute: 'reject',
  });
}

describe('buildApprovalCards', () => {
  test('pending card: workflow name + external risk from graph, no context leak', () => {
    const db = openDb(':memory:');
    seedGraph(db, 'wf');
    makeApproval(db, 'appr-1', 'wf', 'run-1');

    const { pending, resolved } = buildApprovalCards(db);
    expect(resolved).toHaveLength(0);
    expect(pending).toHaveLength(1);
    const card = pending[0];
    expect(card.workflowName).toBe('Gmail Daily');
    expect(card.risk).toBe('high'); // approve → notify output = external
    expect(card.approveEffect).toBe('Continue via "approve" route');

    // The forbidden blob must not appear anywhere in the serialized card.
    expect(JSON.stringify(card)).not.toContain('DO-NOT-LEAK');
    expect(card).not.toHaveProperty('context');
  });

  test('resolved approvals move to the resolved list (inspectable, not pending)', () => {
    const db = openDb(':memory:');
    seedGraph(db, 'wf');
    makeApproval(db, 'appr-1', 'wf', 'run-1');
    db.flowApprovals.resolve('appr-1', 'approved', 'local_operator', 'ok');

    const { pending, resolved } = buildApprovalCards(db);
    expect(pending).toHaveLength(0);
    expect(resolved.map((c) => c.approvalId)).toContain('appr-1');
    const card = resolved.find((c) => c.approvalId === 'appr-1')!;
    expect(card.resolved).toBe(true);
    expect(card.status).toBe('approved');
    expect(card.resolvedBy).toBe('local_operator');
  });
});
