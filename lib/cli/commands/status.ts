/**
 * `igris status` — a safe reachability + company/runtime summary. Read-only; never
 * prints a secret. Aggregates canonical read APIs (providers, missions, approvals).
 */
import type { Ctx } from '@/lib/cli/context';
import { EXIT } from '@/lib/cli/exit';
import { emit, kv } from '@/lib/cli/output';

type ProvidersResp = {
  providers: { id: string; configured: boolean; connected: boolean }[];
  brain: { available: boolean; activeBrain: string };
  default: { model: string; strategy: string };
};

export async function statusCommand(ctx: Ctx): Promise<number> {
  const [providers, missions, approvals] = await Promise.all([
    ctx.client.get<ProvidersResp>('/api/models/providers'),
    ctx.client.get<{ missions: { status: string }[] }>('/api/missions'),
    ctx.client.get<{ approvals: unknown[] }>('/api/flow-approvals'),
  ]);

  const configured = providers.data?.providers?.filter((p) => p.configured).length ?? 0;
  const totalProviders = providers.data?.providers?.length ?? 0;
  const activeMissions = (missions.data?.missions ?? []).filter(
    (m) => !['completed', 'failed', 'cancelled', 'archived'].includes(m.status),
  ).length;
  const pendingApprovals = approvals.data?.approvals?.length ?? 0;
  const def = providers.data?.default;
  const brain = providers.data?.brain;

  const summary = {
    server: ctx.config.baseUrl,
    reachable: true,
    defaultModel: def?.model || 'hermes (brain)',
    defaultStrategy: def?.strategy,
    activeBrain: brain?.activeBrain,
    providersConfigured: `${configured}/${totalProviders}`,
    activeMissions,
    pendingApprovals,
  };

  const human = [
    `IGRIS · ${ctx.config.baseUrl} · reachable`,
    kv([
      ['Default model', summary.defaultModel],
      ['Strategy', summary.defaultStrategy ?? '—'],
      ['Active brain', summary.activeBrain ?? '—'],
      ['Providers configured', summary.providersConfigured],
      ['Active missions', activeMissions],
      ['Pending approvals', pendingApprovals],
    ]),
  ].join('\n');

  emit(ctx.io, ctx.config, human, summary);
  return EXIT.OK;
}
