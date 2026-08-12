/**
 * Node input resolution service (Phase D, spec §33).
 *
 * ONE layer turns a node's ACTIVE incoming edges + the run scope into the
 * structured input handed to an executor. Executors never parse edge mappings
 * themselves (spec §31). Deterministic: edges are merged sorted by source id
 * (then edge id), the same stable order Phase C used, so multi-predecessor
 * merges never depend on completion order (spec §53).
 */
import type { WorkflowEdge } from '@/lib/flows/schema';
import type { NodeOutput, StartRunInput } from '@/lib/flows/run-types';
import {
  resolveField,
  resolveObjectMapping,
  resolveValue,
  stableStringify,
  stringifyValue,
  type RefScope,
} from '@/lib/flows/references';

export type EdgeMappingMode = 'all' | 'field' | 'template' | 'object';

/** One resolved active input, retained so Join can key branches by label (spec §25). */
export type ResolvedSource = {
  nodeId: string;
  /** `targetHandle` (branch label) if the edge set one. */
  handle: string | null;
  mode: EdgeMappingMode;
  /** `all` → the source NodeOutput; otherwise the resolved value. */
  value: unknown;
};

export type ResolvedInputs = { input: NodeOutput; sources: ResolvedSource[] };

const bySourceThenEdge = (a: WorkflowEdge, b: WorkflowEdge): number => {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Resolve the input for a node from its ACTIVE incoming edges. A node with no
 * active incoming edges (a root) receives the run's starting input.
 */
export function resolveNodeInputs(
  activeEdges: WorkflowEdge[],
  scope: RefScope,
  startingInput: StartRunInput,
): ResolvedInputs {
  if (activeEdges.length === 0) {
    return { input: { text: startingInput.text ?? '', data: { upstream: [] } }, sources: [] };
  }

  const sorted = [...activeEdges].sort(bySourceThenEdge);
  const sources: ResolvedSource[] = [];
  const parts: string[] = [];

  for (const e of sorted) {
    const mode: EdgeMappingMode = e.mapping?.mode ?? 'all';
    let value: unknown;
    let text = '';
    if (mode === 'all') {
      const out = (scope[e.source] ?? {}) as NodeOutput;
      value = out;
      text = out.text ?? '';
    } else if (mode === 'field') {
      value = resolveField(e.mapping?.field ?? '', scope);
      text = stringifyValue(value);
    } else if (mode === 'template') {
      value = stringifyValue(resolveValue(e.mapping?.template ?? '', scope));
      text = value as string;
    } else {
      value = resolveObjectMapping(e.mapping?.object ?? {}, scope);
      text = stableStringify(value);
    }
    sources.push({ nodeId: e.source, handle: e.targetHandle ?? null, mode, value });
    if (text) parts.push(text);
  }

  const input: NodeOutput = { text: parts.join('\n\n') };
  if (sources.length === 1) {
    const only = sources[0];
    input.data = only.mode === 'all' ? (only.value as NodeOutput).data : only.value;
  } else {
    input.data = {
      upstream: sources.map((s) => ({ nodeId: s.nodeId, handle: s.handle, value: s.value })),
    };
  }
  return { input, sources };
}
