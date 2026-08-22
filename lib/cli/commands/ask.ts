/**
 * `igris ask "<question>"` — a READ-ONLY operator query grounded in company context and
 * answered by the configured model through the unified runtime (`/api/conductor/ask`).
 * It never mutates and never bypasses context: no free-form provider prompt here.
 */
import type { Ctx } from '@/lib/cli/context';
import { EXIT } from '@/lib/cli/exit';
import { emit } from '@/lib/cli/output';
import { flag, invalid, reportApiError } from '@/lib/cli/context';

export async function askCommand(ctx: Ctx): Promise<number> {
  const question = ctx.args.filter((a) => !a.startsWith('-')).join(' ').trim();
  if (!question) return invalid(ctx, 'usage: ask "<question>" [--model providerId:modelId]');
  const model = flag(ctx, 'model');
  const res = await ctx.client.post<{ answer?: string; model?: string; adapter?: string; error?: string; code?: string }>(
    '/api/conductor/ask',
    { question, ...(model ? { model } : {}) },
  );
  if (!res.ok) {
    // A model/runtime failure is honest (no silent fallback); surface it plainly.
    return reportApiError(ctx, res.status, res.data);
  }
  const human = `${res.data.answer ?? ''}\n\n— answered via ${res.data.model ?? 'default'} (${res.data.adapter ?? 'runtime'})`;
  emit(ctx.io, ctx.config, human, res.data);
  return EXIT.OK;
}
