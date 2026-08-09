/**
 * Agent flow execution. Given a canvas of agent nodes and their connecting
 * edges, run the agents in dependency order: each node's input is the combined
 * output of the nodes feeding into it (or a seed instruction for start nodes).
 * Every node's output is saved to G-Brain shared memory, so the flow's steps
 * are connected through the common brain and readable afterward.
 *
 * Deps (agents, save) are injectable so the engine is unit-testable without a
 * real roster or filesystem.
 */
import { writeBrainDump } from '@/lib/brain-dump';
import type { RuntimeAgent } from '@/lib/agents/runtime';

export type FlowNodeLite = { id: string; agentId: string };
export type FlowEdgeLite = { source: string; target: string };
export type FlowStep = { nodeId: string; agentId: string; agentName: string; ok: boolean; output: string };
export type FlowRunResult = { ok: boolean; steps: FlowStep[]; detail: string };

export type FlowRunDeps = {
  agents: RuntimeAgent[];
  save: (title: string, note: string) => void;
};

const defaultSave = (title: string, note: string): void => {
  try {
    writeBrainDump({ text: note, title, folder: 'inbox', tags: ['flow'] });
  } catch {
    // saving to G-Brain is best-effort; a full disk / missing store never fails a run
  }
};

/** Kahn topological order; nodes left in a cycle are appended in canvas order so
 *  the run still completes deterministically instead of stalling. */
export function flowOrder(nodes: FlowNodeLite[], edges: FlowEdgeLite[]): string[] {
  const ids = nodes.map((n) => n.id);
  const idset = new Set(ids);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const outs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!idset.has(e.source) || !idset.has(e.target) || e.source === e.target) continue;
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    outs.get(e.source)!.push(e.target);
  }
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
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
  for (const id of ids) if (!seen.has(id)) order.push(id); // cycle remnants
  return order;
}

export async function runAgentFlow(
  nodes: FlowNodeLite[],
  edges: FlowEdgeLite[],
  deps: FlowRunDeps,
  opts: { initialInput?: string } = {},
): Promise<FlowRunResult> {
  const agentById = new Map(deps.agents.map((a) => [a.id, a]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const preds = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (preds.has(e.target)) preds.get(e.target)!.push(e.source);

  const seed = opts.initialInput?.trim() || 'Run your task using any prior context, and report your result concisely.';
  const outputByNode = new Map<string, string>();
  const steps: FlowStep[] = [];

  for (const nodeId of flowOrder(nodes, edges)) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const agent = agentById.get(node.agentId);
    const upstream = (preds.get(nodeId) ?? []).map((p) => outputByNode.get(p)).filter(Boolean).join('\n\n');
    const input = upstream || seed;

    if (!agent) {
      steps.push({ nodeId, agentId: node.agentId, agentName: node.agentId, ok: false, output: `agent "${node.agentId}" not found` });
      continue;
    }

    let ok = false;
    let output = '';
    try {
      const res = agent.respond ? await agent.respond(input) : await agent.run();
      ok = res.ok;
      output = res.summary;
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
    }
    steps.push({ nodeId, agentId: agent.id, agentName: agent.name, ok, output });
    outputByNode.set(nodeId, output);
    if (ok && output) deps.save(`Flow · ${agent.name}`, output);
  }

  const ranOk = steps.length > 0 && steps.every((s) => s.ok);
  return {
    ok: ranOk,
    steps,
    detail: steps.length === 0 ? 'The flow has no agent nodes to run.' : `Ran ${steps.length} step${steps.length === 1 ? '' : 's'}.`,
  };
}

export const FLOW_SAVE = defaultSave;
