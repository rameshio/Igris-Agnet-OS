/**
 * `igris models …` — inspect providers and control the global default model through the
 * canonical server-side config (`/api/models/*`). Never prints or accepts a secret.
 *   models [providers]      list providers + configured/connected state + capabilities
 *   models current          show the effective global default model
 *   models use <p> <m>      set the default (mutation → confirm unless --yes)
 *                           also: `use hermes|auto|default`
 */
import type { Ctx } from '@/lib/cli/context';
import { EXIT } from '@/lib/cli/exit';
import { emit, table } from '@/lib/cli/output';
import { ensureConfirmed, invalid, reportApiError } from '@/lib/cli/context';

type ProvidersResp = {
  providers: { id: string; name: string; configured: boolean; connected: boolean; enabled: boolean; capabilities: string[]; models: string[] }[];
  brain: { name: string; available: boolean; activeBrain: string; capabilities: string[] };
  default: { model: string; strategy: string };
};

async function listProviders(ctx: Ctx): Promise<number> {
  const res = await ctx.client.get<ProvidersResp>('/api/models/providers');
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const rows = res.data.providers.map((p) => [
    p.id,
    p.connected ? 'connected' : p.configured ? 'configured' : 'not configured',
    p.enabled ? '' : 'disabled',
    p.capabilities.join(','),
    String(p.models.length),
  ]);
  rows.push(['hermes', res.data.brain.available ? 'available' : 'inactive', `brain (${res.data.brain.activeBrain})`, res.data.brain.capabilities.join(','), '—']);
  const human = [
    table(['PROVIDER', 'STATUS', 'NOTE', 'CAPABILITIES', 'MODELS'], rows),
    '',
    `default model: ${res.data.default.model || 'hermes (brain)'} · strategy: ${res.data.default.strategy}`,
  ].join('\n');
  emit(ctx.io, ctx.config, human, res.data);
  return EXIT.OK;
}

async function currentModel(ctx: Ctx): Promise<number> {
  const res = await ctx.client.get<{ model: string; strategy: string }>('/api/models/default');
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  emit(ctx.io, ctx.config, `default model: ${res.data.model || 'hermes (brain)'} · strategy: ${res.data.strategy}`, res.data);
  return EXIT.OK;
}

/** Turn `use` positionals into the canonical model string. */
function modelStringFromUseArgs(rest: string[]): string | null {
  if (rest.length === 0) return null;
  const [a, b] = rest;
  if (['hermes', 'auto'].includes(a) && rest.length === 1) return a;
  if (['default', 'brain'].includes(a) && rest.length === 1) return '';
  if (rest.length === 2) return `${a}:${b}`; // provider model
  return null;
}

async function useModel(ctx: Ctx): Promise<number> {
  const model = modelStringFromUseArgs(ctx.args.slice(1));
  if (model === null) return invalid(ctx, 'usage: models use <provider> <model>  (or: use hermes|auto|default)');
  const proceed = await ensureConfirmed(ctx, `Set global default model to: ${model || 'hermes (brain)'}`);
  if (!proceed) {
    ctx.io.err('Aborted.');
    return EXIT.ACTION_NOT_COMPLETED;
  }
  const res = await ctx.client.post<{ ok: boolean; model: string; strategy: string; error?: string }>('/api/models/default', { model });
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  emit(ctx.io, ctx.config, `default model set to: ${res.data.model || 'hermes (brain)'} · strategy: ${res.data.strategy}`, res.data);
  return EXIT.OK;
}

export async function modelsCommand(ctx: Ctx): Promise<number> {
  const sub = ctx.args[0] ?? 'providers';
  if (sub === 'providers' || sub === 'list' || ctx.args.length === 0) return listProviders(ctx);
  if (sub === 'current') return currentModel(ctx);
  if (sub === 'use') return useModel(ctx);
  return invalid(ctx, `unknown models subcommand "${sub}" (try: providers | current | use)`);
}
