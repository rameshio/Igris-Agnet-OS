/**
 * Workflow validator v1. Pure — no DB/React — so the API, the engine (later),
 * and tests share it. Detects the structural problems the spec requires before
 * a workflow is saved as a version or run.
 *
 * Phase A is DAG-only, so cycles are an error. Callers pass the set of known
 * agent ids so agent-node references can be checked.
 */
import { WorkflowGraphSchema, type NodeType, type WorkflowGraph } from '@/lib/flows/schema';
import { nodeExecutorRegistry } from '@/lib/flows/registry';
import { NODE_TYPE_META } from '@/lib/flows/node-types';
import { extractReferenceRoots } from '@/lib/flows/references';

export type ValidationIssue = {
  code:
    | 'empty'
    | 'malformed'
    | 'duplicate_node_id'
    | 'unknown_node_type'
    | 'invalid_node_config'
    | 'dangling_edge'
    | 'self_edge'
    | 'invalid_edge_ref'
    | 'missing_agent'
    | 'cycle'
    | 'unsupported_node_type'
    | 'no_output'
    // Phase D:
    | 'invalid_reference'
    | 'unknown_reference_source'
    | 'decision_no_routes'
    | 'duplicate_route'
    | 'unknown_route_handle'
    | 'join_no_inputs'
    | 'invalid_mapping';
  message: string;
  nodeId?: string;
  edgeId?: string;
};

export type ValidationResult = { ok: boolean; issues: ValidationIssue[] };

export type ValidateOptions = {
  /** Ids of agents that exist, so agent nodes can be checked. */
  agentIds?: Set<string>;
  /** Require at least one node (block saving an empty version). */
  requireNonEmpty?: boolean;
};

/** Detect a cycle in a directed graph via DFS coloring. Returns true if any cycle. */
function hasCycle(nodeIds: string[], edges: { source: string; target: string }[]): boolean {
  const adj = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const e of edges) if (adj.has(e.source) && adj.has(e.target) && e.source !== e.target) adj.get(e.source)!.push(e.target);
  const color = new Map<string, 0 | 1 | 2>(nodeIds.map((id) => [id, 0])); // 0=white 1=gray 2=black
  const stack: { id: string; i: number }[] = [];
  for (const start of nodeIds) {
    if (color.get(start) !== 0) continue;
    stack.push({ id: start, i: 0 });
    color.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const nexts = adj.get(top.id) ?? [];
      if (top.i < nexts.length) {
        const n = nexts[top.i++];
        const c = color.get(n);
        if (c === 1) return true; // back-edge → cycle
        if (c === 0) {
          color.set(n, 1);
          stack.push({ id: n, i: 0 });
        }
      } else {
        color.set(top.id, 2);
        stack.pop();
      }
    }
  }
  return false;
}

export function validateWorkflowGraph(input: unknown, opts: ValidateOptions = {}): ValidationResult {
  const issues: ValidationIssue[] = [];

  const parsed = WorkflowGraphSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [{ code: 'malformed', message: `Workflow graph is malformed: ${parsed.error.issues[0]?.message ?? 'invalid'}` }],
    };
  }
  const graph: WorkflowGraph = parsed.data;

  if (opts.requireNonEmpty && graph.nodes.length === 0) {
    issues.push({ code: 'empty', message: 'Workflow has no nodes.' });
  }

  // duplicate node ids
  const seen = new Set<string>();
  const nodeIds = new Set<string>();
  for (const n of graph.nodes) {
    if (seen.has(n.id)) issues.push({ code: 'duplicate_node_id', message: `Duplicate node id "${n.id}".`, nodeId: n.id });
    seen.add(n.id);
    nodeIds.add(n.id);
  }

  // per-node: known type + valid config (+ agent reference)
  for (const n of graph.nodes) {
    if (!(n.type in NODE_TYPE_META)) {
      issues.push({ code: 'unknown_node_type', message: `Unknown node type "${n.type}".`, nodeId: n.id });
      continue;
    }
    const configErrors = nodeExecutorRegistry.get(n.type as NodeType)?.validateConfig(n.config) ?? [];
    for (const e of configErrors) {
      issues.push({ code: 'invalid_node_config', message: `Node "${n.id}" (${n.type}): ${e}`, nodeId: n.id });
    }
    if (n.type === 'agent' && opts.agentIds) {
      const agentId = (n.config as { agentId?: string }).agentId;
      if (agentId && !opts.agentIds.has(agentId)) {
        issues.push({ code: 'missing_agent', message: `Agent node "${n.id}" references a missing agent "${agentId}".`, nodeId: n.id });
      }
    }
  }

  // edges: valid refs, no self-edges, no dangling
  const edgeIds = new Set<string>();
  for (const e of graph.edges) {
    if (edgeIds.has(e.id)) issues.push({ code: 'invalid_edge_ref', message: `Duplicate edge id "${e.id}".`, edgeId: e.id });
    edgeIds.add(e.id);
    if (!e.source || !e.target) {
      issues.push({ code: 'invalid_edge_ref', message: `Edge "${e.id}" is missing a source or target.`, edgeId: e.id });
      continue;
    }
    if (e.source === e.target) issues.push({ code: 'self_edge', message: `Edge "${e.id}" connects a node to itself.`, edgeId: e.id });
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) {
      issues.push({ code: 'dangling_edge', message: `Edge "${e.id}" points to a node that does not exist.`, edgeId: e.id });
    }
  }

  // ── Phase D: reference / decision / mapping / join structural checks ──
  // Valid reference roots = every node id, plus each unique, non-colliding label.
  const validRoots = new Set<string>(nodeIds);
  {
    const labelCounts = new Map<string, number>();
    for (const n of graph.nodes) if (n.label) labelCounts.set(n.label, (labelCounts.get(n.label) ?? 0) + 1);
    for (const n of graph.nodes) if (n.label && labelCounts.get(n.label) === 1 && !nodeIds.has(n.label)) validRoots.add(n.label);
  }
  const checkRefs = (template: string, where: string, loc: { nodeId?: string; edgeId?: string }): void => {
    const { roots, invalid } = extractReferenceRoots(template);
    for (const bad of invalid) issues.push({ code: 'invalid_reference', message: `${where}: reference "{{${bad}}}" is not a valid property path.`, ...loc });
    for (const r of roots) if (!validRoots.has(r)) issues.push({ code: 'unknown_reference_source', message: `${where}: reference source "${r}" is not a node in this workflow.`, ...loc });
  };

  const decisionRoutes = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    if (n.type === 'transform') {
      const c = n.config;
      const mode = c.mode ?? 'object';
      if (mode === 'template' && c.template) checkRefs(c.template, `Transform "${n.id}"`, { nodeId: n.id });
      else if (mode === 'field' && c.field) checkRefs(c.field, `Transform "${n.id}"`, { nodeId: n.id });
      else if (mode === 'object') for (const k of Object.keys(c.object ?? {})) checkRefs((c.object ?? {})[k], `Transform "${n.id}" key "${k}"`, { nodeId: n.id });
    }
    if (n.type === 'decision') {
      const rules = n.config.rules ?? [];
      const routes = new Set<string>();
      if (rules.length === 0 && !n.config.defaultRoute) issues.push({ code: 'decision_no_routes', message: `Decision "${n.id}" has no rules and no default route.`, nodeId: n.id });
      for (const r of rules) {
        if (routes.has(r.route)) issues.push({ code: 'duplicate_route', message: `Decision "${n.id}" declares route "${r.route}" more than once.`, nodeId: n.id });
        routes.add(r.route);
        checkRefs(r.condition.left, `Decision "${n.id}" rule "${r.route}"`, { nodeId: n.id });
        if (typeof r.condition.right === 'string') checkRefs(r.condition.right, `Decision "${n.id}" rule "${r.route}" (right)`, { nodeId: n.id });
      }
      if (n.config.defaultRoute) routes.add(n.config.defaultRoute);
      decisionRoutes.set(n.id, routes);
    }
    if (n.type === 'join' && !graph.edges.some((e) => e.target === n.id)) {
      issues.push({ code: 'join_no_inputs', message: `Join "${n.id}" has no incoming branches.`, nodeId: n.id });
    }
  }

  for (const e of graph.edges) {
    const routes = decisionRoutes.get(e.source);
    if (routes) {
      if (e.sourceHandle == null) issues.push({ code: 'unknown_route_handle', message: `Edge "${e.id}" leaves Decision "${e.source}" without a route handle.`, edgeId: e.id });
      else if (!routes.has(e.sourceHandle)) issues.push({ code: 'unknown_route_handle', message: `Edge "${e.id}" uses route "${e.sourceHandle}" not declared by Decision "${e.source}".`, edgeId: e.id });
    }
    const m = e.mapping;
    if (m?.mode === 'field' && m.field) checkRefs(m.field, `Edge "${e.id}" field mapping`, { edgeId: e.id });
    if (m?.mode === 'template' && m.template) checkRefs(m.template, `Edge "${e.id}" template mapping`, { edgeId: e.id });
    if (m?.mode === 'object' && m.object) for (const k of Object.keys(m.object)) checkRefs(m.object[k], `Edge "${e.id}" object mapping "${k}"`, { edgeId: e.id });
    if (e.condition) {
      checkRefs(e.condition.left, `Edge "${e.id}" condition`, { edgeId: e.id });
      if (typeof e.condition.right === 'string') checkRefs(e.condition.right, `Edge "${e.id}" condition (right)`, { edgeId: e.id });
    }
  }

  // Phase A is DAG-only
  if (hasCycle([...nodeIds], graph.edges)) {
    issues.push({ code: 'cycle', message: 'Workflow contains a cycle (not supported yet).' });
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Execution-validity (Phase C): graph must be valid AND every node type must be
 * runnable in the current runtime, with at least one Output node. This is a pure
 * configuration check — it does NOT probe live provider health (that would make
 * validation nondeterministic). Requires the executable executors to be
 * registered (import the engine before calling).
 */
export function validateExecutable(input: unknown, opts: ValidateOptions = {}): ValidationResult {
  const base = validateWorkflowGraph(input, { ...opts, requireNonEmpty: true });
  const parsed = WorkflowGraphSchema.safeParse(input);
  if (!parsed.success) return base; // already malformed
  const issues = [...base.issues];
  for (const n of parsed.data.nodes) {
    if (!nodeExecutorRegistry.isExecutable(n.type as NodeType)) {
      issues.push({ code: 'unsupported_node_type', message: `Node "${n.id}" (${n.type}) is not runnable yet — remove it before running.`, nodeId: n.id });
    }
  }
  if (parsed.data.nodes.length > 0 && !parsed.data.nodes.some((n) => n.type === 'output')) {
    issues.push({ code: 'no_output', message: 'Workflow has no Output node.' });
  }
  return { ok: issues.length === 0, issues };
}
