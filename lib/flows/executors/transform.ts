/**
 * Transform executor (Phase D) — a deterministic, code-free data reshape.
 *
 * NEVER calls an LLM and NEVER executes JavaScript/shell/dynamic code (spec §21):
 * it only resolves `{{Node.field}}` references through the shared resolver. Three
 * declarative modes: build an object, render a text template, or pass a single
 * field through. References resolve against the run scope (all succeeded nodes).
 */
import { validateNodeConfig, type NodeExecutor } from '@/lib/flows/registry';
import { NodeExecError, errorMessageOf } from '@/lib/flows/errors';
import { resolveField, resolveObjectMapping, resolveValue, stableStringify, stringifyValue } from '@/lib/flows/references';

type TransformConfig = {
  mode?: 'object' | 'template' | 'field';
  object?: Record<string, string>;
  template?: string;
  field?: string;
};

export const transformExecutor: NodeExecutor = {
  type: 'transform',
  executable: true,
  validateConfig: (c) => validateNodeConfig('transform', c),
  async execute(ctx) {
    const cfg = ctx.node.config as TransformConfig;
    const mode = cfg.mode ?? 'object';
    try {
      if (mode === 'template') {
        return { output: { text: stringifyValue(resolveValue(cfg.template ?? '', ctx.scope)) } };
      }
      if (mode === 'field') {
        const value = resolveField(cfg.field ?? '', ctx.scope);
        return { output: { text: stringifyValue(value), data: value } };
      }
      const obj = resolveObjectMapping(cfg.object ?? {}, ctx.scope);
      return { output: { data: obj, text: stableStringify(obj) } };
    } catch (err) {
      // A missing reference keeps its specific code; anything else is transform_failed.
      if (err instanceof NodeExecError) throw err;
      throw new NodeExecError('transform_failed', errorMessageOf(err));
    }
  },
};
