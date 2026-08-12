/**
 * Join executor (Phase D) — synchronizes active branches (spec §24-§27).
 *
 * The engine only runs a Join once every incoming source is terminal and hands
 * it the ACTIVE branches (a branch skipped by a Decision never appears), so Join
 * never waits forever for an intentionally-skipped branch (spec §27). Output is a
 * deterministic `data.branches` map keyed by each edge's stable label
 * (`targetHandle`, else the source node id) — never an order-dependent concat
 * (spec §24/§53).
 */
import { validateNodeConfig, type NodeExecutor } from '@/lib/flows/registry';
import { NodeExecError } from '@/lib/flows/errors';
import { stringifyValue } from '@/lib/flows/references';
import type { NodeOutput } from '@/lib/flows/run-types';

export const joinExecutor: NodeExecutor = {
  type: 'join',
  executable: true,
  validateConfig: (c) => validateNodeConfig('join', c),
  async execute(ctx) {
    if (ctx.sources.length === 0) {
      throw new NodeExecError('join_invalid_inputs', 'Join has no active incoming branches.');
    }
    const branches: Record<string, unknown> = {};
    for (const s of ctx.sources) {
      // Deterministic, stable key: explicit branch label wins, else the source id.
      const key = s.handle ?? s.nodeId;
      branches[key] = s.value;
    }
    const text = Object.keys(branches)
      .sort()
      .map((k) => {
        const v = branches[k];
        if (v && typeof v === 'object' && 'text' in (v as object)) return (v as NodeOutput).text ?? '';
        return stringifyValue(v);
      })
      .filter(Boolean)
      .join('\n\n');
    return { output: { text, data: { branches } } };
  },
};
