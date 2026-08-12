/**
 * WorkflowEngine (Phase C, extended in Phase D branching/logic and Phase E
 * durable human-approval pause/resume).
 *
 * Executes an IMMUTABLE workflow version in dependency (topological) order,
 * driving node executors through the registry and persisting every node run.
 * Backend-only, no React. Sequential — "parallel" branches are independent and
 * may run in any order, so sequential execution preserves their semantics
 * (spec §23) without introducing races.
 *
 * Phase D adds an ACTIVE-EDGE model. An edge delivers data only when its source
 * succeeded AND the edge is selected: a Decision activates only the edge whose
 * `sourceHandle` matches the chosen route; a conditional edge activates only when
 * its condition is true. A node with incoming edges but no ACTIVE one is SKIPPED
 * (not failed). Fail-fast is unchanged: a failed node fails the run and its
 * dependents are skipped. The engine never writes runtime status into the graph.
 *
 * Phase E adds a DURABLE PAUSE. A Human Approval node is a human gate (kept
 * strictly separate from the machine-logic Decision node). When the scheduler
 * reaches an unresolved approval node it writes a `pending` flow_approvals row,
 * marks the node + run `waiting_approval`, and RETURNS without failing. The run
 * is now durable state in SQLite — it survives refresh, hot-reload, and process
 * restart. `resumeRun(runId)` reconstructs the in-memory scheduler state from the
 * persisted node runs, applies the human's decision (the approval node then
 * routes like a Decision via `data.selectedRoute`), and continues — NEVER
 * re-running a node that already succeeded (no upstream LLM/tool re-calls).
 */
import '@/lib/flows/executors'; // side effect: register executable executors
import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import type { RuntimeAgent } from '@/lib/agents/runtime';
import type { WorkflowGraph, WorkflowEdge } from '@/lib/flows/schema';
import { ApprovalConfigSchema } from '@/lib/flows/schema';
import type { FlowRun, FlowApproval, NodeOutput, NodeRunStatus, StartRunInput } from '@/lib/flows/run-types';
import { nodeExecutorRegistry } from '@/lib/flows/registry';
import { NodeExecError, errorCodeOf, errorMessageOf } from '@/lib/flows/errors';
import { buildScope, resolveValue } from '@/lib/flows/references';
import { resolveNodeInputs } from '@/lib/flows/inputs';
import { evaluateCondition } from '@/lib/flows/conditions';

const uid = (p: string) => `${p}-${randomUUID()}`;
const now = () => new Date().toISOString();

/** Kahn topological order; remnants (only in a cycle, which the validator blocks) appended. */
export function topoOrder(nodeIds: string[], edges: { source: string; target: string }[]): string[] {
  const idset = new Set(nodeIds);
  const indeg = new Map(nodeIds.map((id) => [id, 0]));
  const outs = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    if (!idset.has(e.source) || !idset.has(e.target) || e.source === e.target) continue;
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    outs.get(e.source)!.push(e.target);
  }
  const queue = nodeIds.filter((id) => (indeg.get(id) ?? 0) === 0);
  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const t of outs.get(id) ?? []) {
      indeg.set(t, (indeg.get(t) ?? 0) - 1);
      if ((indeg.get(t) ?? 0) <= 0) queue.push(t);
    }
  }
  for (const id of nodeIds) if (!seen.has(id)) order.push(id);
  return order;
}

/**
 * LEGACY (Phase C): merge all predecessors' text with mapping "all". Retained for
 * backward-compat and unit tests; the engine now uses `resolveNodeInputs` over
 * ACTIVE edges. Deterministic: predecessors sorted by source id.
 */
export function resolveIncomingInputs(
  nodeId: string,
  edges: WorkflowEdge[],
  state: Record<string, NodeOutput>,
  startingInput: StartRunInput,
): NodeOutput {
  const preds = edges
    .filter((e) => e.target === nodeId)
    .map((e) => e.source)
    .sort();
  if (preds.length === 0) return { text: startingInput.text ?? '', data: { upstream: [] } };
  const upstream = preds.map((pid) => ({ nodeId: pid, output: state[pid] ?? null }));
  const text = upstream
    .map((u) => u.output?.text ?? '')
    .filter(Boolean)
    .join('\n\n');
  return { text, data: { upstream } };
}

/** In-memory scheduler state. Reconstructable from persisted node runs (Phase E resume). */
type SchedulerState = {
  state: Record<string, NodeOutput>;
  status: Map<string, NodeRunStatus>;
  nrIdOf: Map<string, string>;
  first: { err: { code: string; message: string } | null };
};

/**
 * Rebuild scheduler state from the persisted node runs of a paused run. A
 * succeeded node keeps its output so downstream references resolve WITHOUT
 * re-running it. A `rejected` approval node is "completed" for routing (its
 * output carries `selectedRoute`). `waiting_approval`/`queued`/`running` nodes
 * are left unset so the scheduler re-evaluates them on resume.
 */
function seedFromNodeRuns(db: FounderDb, run: FlowRun): SchedulerState {
  const state: Record<string, NodeOutput> = {};
  const status = new Map<string, NodeRunStatus>();
  const nrIdOf = new Map<string, string>();
  const first: SchedulerState['first'] = { err: null };
  for (const nr of db.flowNodeRuns.forRun(run.id)) {
    nrIdOf.set(nr.nodeId, nr.id);
    if (nr.status === 'success' || nr.status === 'rejected') {
      // Both are "the node completed"; a rejected approval still routes (reject branch).
      status.set(nr.nodeId, 'success');
      state[nr.nodeId] = nr.output ?? {};
    } else if (nr.status === 'failed') {
      status.set(nr.nodeId, 'failed');
      if (!first.err) first.err = { code: nr.errorCode ?? 'node_failed', message: nr.errorMessage ?? 'Node failed.' };
    } else if (nr.status === 'skipped') {
      status.set(nr.nodeId, 'skipped');
    }
  }
  return { state, status, nrIdOf, first };
}

/** Non-secret snapshot shown to the approver. Never includes credentials/tokens. */
function buildApprovalContext(
  cfg: ReturnType<typeof ApprovalConfigSchema.parse>,
  inputText: string,
  scope: ReturnType<typeof buildScope>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const ref of cfg.contextFields) {
    try {
      fields[ref] = resolveValue(ref.includes('{{') ? ref : `{{${ref}}}`, scope);
    } catch {
      fields[ref] = null; // a missing reference is shown as null, never crashes the pause
    }
  }
  return { inputText, fields };
}

/**
 * Core scheduler. Drives the topological order from wherever `ctx` left off
 * (fresh: everything unresolved; resume: upstream already seeded), pausing at an
 * unresolved approval node. Returns `{ paused: true }` WITHOUT finalizing when it
 * pauses; otherwise finalizes the run (success/failed) and returns `{ paused: false }`.
 */
async function driveSchedule(
  db: FounderDb,
  run: FlowRun,
  graph: WorkflowGraph,
  agents: RuntimeAgent[],
  ctx: SchedulerState,
  signal?: AbortSignal,
): Promise<{ paused: boolean }> {
  const { state, status, nrIdOf, first } = ctx;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const order = topoOrder([...nodeById.keys()], graph.edges);
  const incomingOf = (id: string) => graph.edges.filter((e) => e.target === id);

  const ensureNr = (nodeId: string): string => {
    let id = nrIdOf.get(nodeId);
    if (!id) {
      id = uid('nr');
      nrIdOf.set(nodeId, id);
      db.flowNodeRuns.create({ id, runId: run.id, nodeId, nodeType: nodeById.get(nodeId)!.type, status: 'queued' });
    }
    return id;
  };

  // An edge delivers data only when its source COMPLETED and the edge is selected.
  // A Decision AND a Human Approval each select one route (sourceHandle); a
  // conditional edge selects on truth. Approval routes exactly like a Decision.
  const isEdgeActive = (e: WorkflowEdge, scope: ReturnType<typeof buildScope>): boolean => {
    if (status.get(e.source) !== 'success') return false;
    const src = nodeById.get(e.source);
    if (src?.type === 'decision' || src?.type === 'approval') {
      const route = (state[e.source]?.data as { selectedRoute?: string } | undefined)?.selectedRoute;
      return e.sourceHandle != null && e.sourceHandle === route;
    }
    if (e.condition) return evaluateCondition(e.condition, scope); // may throw → fails the target
    return true;
  };

  const failNode = (nrId: string, nodeId: string, startedMs: number | null, code: string, message: string): void => {
    db.flowNodeRuns.update(nrId, {
      status: 'failed',
      endedAt: now(),
      durationMs: startedMs === null ? null : Date.now() - startedMs,
      errorCode: code,
      errorMessage: message,
    });
    status.set(nodeId, 'failed');
    if (!first.err) first.err = { code, message };
  };

  const runNode = async (nodeId: string, nrId: string, activeIncoming: WorkflowEdge[], scope: ReturnType<typeof buildScope>): Promise<void> => {
    const node = nodeById.get(nodeId)!;
    let resolved;
    try {
      resolved = resolveNodeInputs(activeIncoming, scope, run.startingInput);
    } catch (err) {
      failNode(nrId, nodeId, null, errorCodeOf(err), errorMessageOf(err));
      return;
    }
    db.flowRuns.update(run.id, { currentNodeId: nodeId });
    db.flowNodeRuns.update(nrId, { status: 'running', startedAt: now(), input: resolved.input });
    const startedMs = Date.now();
    try {
      const executor = nodeExecutorRegistry.get(node.type);
      if (!executor?.executable || !executor.execute) {
        throw new NodeExecError('unsupported_node_type', `Node type "${node.type}" is not executable yet.`);
      }
      const res = await executor.execute({
        node,
        input: resolved.input,
        state,
        scope,
        sources: resolved.sources,
        startingInput: run.startingInput,
        db,
        agents,
        signal,
      });
      state[nodeId] = res.output;
      status.set(nodeId, 'success');
      db.flowNodeRuns.update(nrId, {
        status: 'success',
        output: res.output,
        endedAt: now(),
        durationMs: Date.now() - startedMs,
        modelStrategy: res.meta?.strategy ?? null,
        adapter: res.meta?.adapter ?? null,
        providerId: res.meta?.providerId ?? null,
        modelId: res.meta?.modelId ?? null,
        promptTokens: res.meta?.promptTokens ?? null,
        completionTokens: res.meta?.completionTokens ?? null,
        totalTokens: res.meta?.totalTokens ?? null,
        estimatedCost: res.meta?.estimatedCost ?? null,
      });
    } catch (err) {
      failNode(nrId, nodeId, startedMs, errorCodeOf(err), errorMessageOf(err));
    }
  };

  // Apply a resolved (approved/rejected) approval: mark the node completed and
  // set the selected route so downstream edges activate like a Decision.
  const applyResolution = (nodeId: string, nrId: string, appr: FlowApproval): void => {
    const approved = appr.status === 'approved';
    const selectedRoute = approved ? appr.approvalRoute : appr.rejectionRoute;
    const output: NodeOutput = {
      text: appr.resolutionNote ?? '',
      data: {
        decision: appr.status,
        approved,
        selectedRoute,
        resolvedBy: appr.resolvedBy,
        resolvedAt: appr.resolvedAt,
        note: appr.resolutionNote,
      },
    };
    state[nodeId] = output;
    status.set(nodeId, 'success'); // completed the gate — routes downstream
    db.flowNodeRuns.update(nrId, {
      status: approved ? 'success' : 'rejected',
      output,
      endedAt: now(),
      errorCode: approved ? null : 'human_rejected',
      errorMessage: approved ? null : appr.resolutionNote ? `Rejected: ${appr.resolutionNote}` : 'Rejected by approver.',
    });
  };

  // Reach an approval node: apply a resolution, or open a durable pending request
  // and pause. Returns 'paused' when the run must stop and wait for a human.
  const handleApproval = async (nodeId: string, nrId: string, activeIncoming: WorkflowEdge[], scope: ReturnType<typeof buildScope>): Promise<'paused' | 'continue'> => {
    const node = nodeById.get(nodeId)!;
    let resolved;
    try {
      resolved = resolveNodeInputs(activeIncoming, scope, run.startingInput);
    } catch (err) {
      failNode(nrId, nodeId, null, errorCodeOf(err), errorMessageOf(err));
      return 'continue';
    }

    const existing = db.flowApprovals.latestForNodeRun(nrId);
    if (existing && (existing.status === 'approved' || existing.status === 'rejected')) {
      applyResolution(nodeId, nrId, existing);
      return 'continue';
    }
    if (existing && existing.status === 'pending') {
      db.flowNodeRuns.update(nrId, { status: 'waiting_approval' });
      db.flowRuns.update(run.id, { status: 'waiting_approval', currentNodeId: nodeId });
      return 'paused';
    }
    if (existing && (existing.status === 'cancelled' || existing.status === 'expired')) {
      // Terminal non-resolution (run cancel / expiry). Do not route; skip the node.
      db.flowNodeRuns.update(nrId, { status: 'skipped', errorCode: existing.status, errorMessage: `Approval ${existing.status}.` });
      status.set(nodeId, 'skipped');
      return 'continue';
    }

    // No approval yet → create the durable pending request and pause.
    const cfg = ApprovalConfigSchema.parse(node.config ?? {});
    let message = cfg.message;
    try {
      message = String(resolveValue(cfg.message, scope) ?? '');
    } catch {
      message = cfg.message; // a missing reference falls back to the literal template
    }
    const inputText = resolved.input.text ?? '';
    db.flowNodeRuns.update(nrId, { status: 'waiting_approval', input: resolved.input, startedAt: now() });
    db.flowApprovals.create({
      id: uid('appr'),
      runId: run.id,
      nodeRunId: nrId,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      nodeId,
      requestType: 'workflow',
      title: cfg.title || 'Human approval required',
      message,
      context: buildApprovalContext(cfg, inputText, scope),
      approvalRoute: cfg.approveRoute,
      rejectionRoute: cfg.rejectRoute,
    });
    db.flowRuns.update(run.id, { status: 'waiting_approval', currentNodeId: nodeId });
    return 'paused';
  };

  for (const nodeId of order) {
    if (status.has(nodeId)) continue; // already terminal (seeded on resume) — never re-run
    const node = nodeById.get(nodeId)!;
    const nrId = ensureNr(nodeId);
    const incoming = incomingOf(nodeId);
    const scope = buildScope(graph.nodes, state);

    let activeIncoming: WorkflowEdge[];
    if (incoming.length === 0) {
      activeIncoming = []; // root node — runs with the starting input
    } else {
      try {
        activeIncoming = incoming.filter((e) => isEdgeActive(e, scope));
      } catch (err) {
        failNode(nrId, nodeId, null, errorCodeOf(err), errorMessageOf(err));
        continue;
      }
      if (activeIncoming.length === 0) {
        // Reachable by no active path → SKIPPED, not failed (spec §18/§30).
        const anySucceeded = incoming.some((e) => status.get(e.source) === 'success');
        const reason = anySucceeded ? 'branch_not_selected' : 'upstream_skipped';
        const message = anySucceeded ? 'Skipped — this branch was not selected.' : 'Skipped — a required upstream node did not run.';
        db.flowNodeRuns.update(nrId, { status: 'skipped', errorCode: reason, errorMessage: message });
        status.set(nodeId, 'skipped');
        continue;
      }
    }

    if (node.type === 'approval') {
      const outcome = await handleApproval(nodeId, nrId, activeIncoming, scope);
      if (outcome === 'paused') return { paused: true }; // durable stop — do NOT finalize
      continue;
    }

    await runNode(nodeId, nrId, activeIncoming, scope);
  }

  const nodeRuns = db.flowNodeRuns.forRun(run.id);
  const tokenSum = nodeRuns.reduce((s, nr) => s + (nr.totalTokens ?? 0), 0);
  db.flowRuns.update(run.id, {
    status: first.err ? 'failed' : 'success',
    endedAt: now(),
    currentNodeId: null,
    errorCode: first.err?.code ?? null,
    errorMessage: first.err?.message ?? null,
    totalTokens: tokenSum > 0 ? tokenSum : null,
    estimatedCost: null,
  });
  return { paused: false };
}

/** Execute a fresh run to completion OR to its first approval pause, persisting each step. */
export async function executeRun(
  db: FounderDb,
  run: FlowRun,
  graph: WorkflowGraph,
  agents: RuntimeAgent[],
  signal?: AbortSignal,
): Promise<void> {
  db.flowRuns.update(run.id, { status: 'running', startedAt: now() });

  const nrIdOf = new Map<string, string>();
  for (const n of graph.nodes) {
    const id = uid('nr');
    nrIdOf.set(n.id, id);
    db.flowNodeRuns.create({ id, runId: run.id, nodeId: n.id, nodeType: n.type, status: 'queued' });
  }

  const ctx: SchedulerState = { state: {}, status: new Map(), nrIdOf, first: { err: null } };
  await driveSchedule(db, run, graph, agents, ctx, signal);
}

/**
 * Resume a run that PAUSED on a Human Approval node (Phase E). Loads the run and
 * its IMMUTABLE version, rebuilds scheduler state from the persisted node runs
 * (never re-running a succeeded node — no upstream LLM/tool re-calls), applies the
 * human's decision, and continues. Idempotent: a run not in `waiting_approval` is
 * a no-op (a double resume after one approval does nothing). Original run id is
 * preserved throughout.
 */
export async function resumeRun(db: FounderDb, runId: string, agents: RuntimeAgent[], signal?: AbortSignal): Promise<void> {
  const run = db.flowRuns.get(runId);
  if (!run) throw new NodeExecError('run_not_found', `Run "${runId}" was not found.`);
  if (run.status !== 'waiting_approval') return; // only paused runs resume — idempotent

  const version = db.flowVersions.get(run.workflowId, run.workflowVersion);
  if (!version) throw new NodeExecError('workflow_version_not_found', `Version ${run.workflowVersion} of "${run.workflowId}" was not found.`);

  const ctx = seedFromNodeRuns(db, run);
  db.flowRuns.update(run.id, { status: 'running' }); // resuming execution
  await driveSchedule(db, run, version.graph, agents, ctx, signal);
}

/** The run's final output = concatenated text of succeeded Output nodes (deterministic). */
export function finalOutput(graph: WorkflowGraph, state: Record<string, NodeOutput>): NodeOutput | null {
  const outs = graph.nodes.filter((n) => n.type === 'output').map((n) => n.id).sort();
  const parts = outs.map((id) => state[id]?.text ?? '').filter(Boolean);
  return outs.length ? { text: parts.join('\n\n') } : null;
}
