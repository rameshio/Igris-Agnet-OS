/**
 * Parallel executor (Phase D) — an explicit fan-out control node (spec §22).
 *
 * The dependency scheduler already lets a node's multiple successors proceed
 * independently, so Parallel is a deterministic pass-through that exists for
 * clear orchestration semantics and UI readability. It emits its input unchanged;
 * its outgoing edges each start an independent branch.
 */
import { validateNodeConfig, type NodeExecutor } from '@/lib/flows/registry';

export const parallelExecutor: NodeExecutor = {
  type: 'parallel',
  executable: true,
  validateConfig: (c) => validateNodeConfig('parallel', c),
  async execute(ctx) {
    return { output: { text: ctx.input.text ?? '', data: ctx.input.data } };
  },
};
