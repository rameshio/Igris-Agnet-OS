/**
 * WorkflowEngine (Phase C). Executes an IMMUTABLE workflow version in dependency
 * order, driving node executors through the registry and persisting every node
 * run. Backend-only, no React. Sequential (parallel/join is Phase D) but written
 * so concurrency can be added later. Fail-fast: a failed node fails the run and
 * skips dependents. Never writes runtime status back into the graph definition.
 */
import '@/lib/flows/executors'; // side effect: register executable executors
import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import type { RuntimeAgent } from '@/lib/agents/runtime';
import type { WorkflowGraph, WorkflowEdge } from '@/lib/flows/schema';
import type { FlowRun, NodeOutput, StartRunInput } from '@/lib/flows/run-types';
import { nodeExecutorRegistry } from '@/lib/flows/registry';
import { NodeExecError, errorCodeOf, errorMessageOf } from '@/lib/flows/errors';

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
 * Resolve the input a node receives from its predecessors (Phase C: mapping
 * "all"). Deterministic: predecessors are sorted by source node id, so
 * multiple incoming edges always merge in a stable order — the foundation
 * Phase D's field/conditional mapping extends. A node with no predecessors
 * receives the run's starting input.
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

/** Execute one run to completion, persisting each step. Resolves when finalized. */
export async function executeRun(
  db: FounderDb,
  run: FlowRun,
  graph: WorkflowGraph,
  agents: RuntimeAgent[],
  signal?: AbortSignal,
): Promise<void> {
  db.flowRuns.update(run.id, { status: 'running', startedAt: now() });

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const order = topoOrder([...nodeById.keys()], graph.edges);
  const nrIdOf = new Map<string, string>();
  for (const n of graph.nodes) {
    const id = uid('nr');
    nrIdOf.set(n.id, id);
    db.flowNodeRuns.create({ id, runId: run.id, nodeId: n.id, nodeType: n.type, status: 'queued' });
  }

  const state: Record<string, NodeOutput> = {};
  const done = new Set<string>(); // succeeded node ids
  const blocked = new Set<string>(); // failed or skipped node ids
  const predsOf = (id: string) => graph.edges.filter((e) => e.target === id).map((e) => e.source);
  let firstErr: { code: string; message: string } | null = null;

  for (const nodeId of order) {
    const node = nodeById.get(nodeId)!;
    const nrId = nrIdOf.get(nodeId)!;

    // A required predecessor did not succeed → skip this node.
    if (predsOf(nodeId).some((p) => blocked.has(p) || !done.has(p))) {
      db.flowNodeRuns.update(nrId, { status: 'skipped', errorCode: 'upstream_failed', errorMessage: 'A required upstream node did not succeed.' });
      blocked.add(nodeId);
      continue;
    }

    const input = resolveIncomingInputs(nodeId, graph.edges, state, run.startingInput);
    db.flowRuns.update(run.id, { currentNodeId: nodeId });
    db.flowNodeRuns.update(nrId, { status: 'running', startedAt: now(), input });
    const startedMs = Date.now();
    try {
      const executor = nodeExecutorRegistry.get(node.type);
      if (!executor?.executable || !executor.execute) {
        throw new NodeExecError('unsupported_node_type', `Node type "${node.type}" is not executable yet.`);
      }
      const res = await executor.execute({ node, input, state, startingInput: run.startingInput, db, agents, signal });
      state[nodeId] = res.output;
      done.add(nodeId);
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
      const code = errorCodeOf(err);
      const message = errorMessageOf(err);
      db.flowNodeRuns.update(nrId, { status: 'failed', endedAt: now(), durationMs: Date.now() - startedMs, errorCode: code, errorMessage: message });
      blocked.add(nodeId);
      if (!firstErr) firstErr = { code, message };
    }
  }

  const nodeRuns = db.flowNodeRuns.forRun(run.id);
  const tokenSum = nodeRuns.reduce((s, nr) => s + (nr.totalTokens ?? 0), 0);
  db.flowRuns.update(run.id, {
    status: firstErr ? 'failed' : 'success',
    endedAt: now(),
    currentNodeId: null,
    errorCode: firstErr?.code ?? null,
    errorMessage: firstErr?.message ?? null,
    totalTokens: tokenSum > 0 ? tokenSum : null,
    estimatedCost: null,
  });
}

/** The run's final output = concatenated text of succeeded Output nodes (deterministic). */
export function finalOutput(graph: WorkflowGraph, state: Record<string, NodeOutput>): NodeOutput | null {
  const outs = graph.nodes.filter((n) => n.type === 'output').map((n) => n.id).sort();
  const parts = outs.map((id) => state[id]?.text ?? '').filter(Boolean);
  return outs.length ? { text: parts.join('\n\n') } : null;
}
