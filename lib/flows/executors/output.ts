/** Output executor (Phase C): marks the incoming value as the run's final result. */
import { validateNodeConfig, type NodeExecutor } from '@/lib/flows/registry';

export const outputExecutor: NodeExecutor = {
  type: 'output',
  executable: true,
  validateConfig: (c) => validateNodeConfig('output', c),
  async execute(ctx) {
    return { output: { text: ctx.input.text ?? '', data: ctx.input.data } };
  },
};
