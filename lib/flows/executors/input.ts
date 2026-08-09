/** Input executor (Phase C): emits the run's starting input as typed output. */
import { validateNodeConfig, type NodeExecutor } from '@/lib/flows/registry';

export const inputExecutor: NodeExecutor = {
  type: 'input',
  executable: true,
  validateConfig: (c) => validateNodeConfig('input', c),
  async execute(ctx) {
    const cfg = ctx.node.config as { value?: string };
    // The run's starting input wins; the node's stored value is a fallback.
    const text = ctx.startingInput.text?.trim() ? ctx.startingInput.text : (cfg.value ?? '');
    return { output: { text, data: { source: 'input' } } };
  },
};
