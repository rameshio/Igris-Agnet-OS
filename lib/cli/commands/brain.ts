/**
 * `igris brain …` and `igris intelligence …` — read-only knowledge + analytics over the
 * canonical G-Brain (F3) and Company Intelligence (F6) APIs. Browsing never persists
 * knowledge; promotion is a separate, explicit, confirmed command.
 */
import type { Ctx } from '@/lib/cli/context';
import { EXIT } from '@/lib/cli/exit';
import { emit, table, kv, formatRefValue } from '@/lib/cli/output';
import { ensureConfirmed, flag, invalid, reportApiError } from '@/lib/cli/context';

async function brainSearch(ctx: Ctx): Promise<number> {
  const q = ctx.args.slice(1).filter((a) => !a.startsWith('-')).join(' ') || flag(ctx, 'query') || '';
  if (!q) return invalid(ctx, 'usage: brain search "<query>"');
  const res = await ctx.client.get<{ query: string; results: { kind?: string; title?: string; snippet?: string }[] }>(`/api/brain/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const rows = res.data.results.map((r) => [r.kind ?? '—', (r.title ?? '').slice(0, 48), (r.snippet ?? '').slice(0, 60)]);
  emit(ctx.io, ctx.config, rows.length ? table(['KIND', 'TITLE', 'SNIPPET'], rows) : `no results for "${q}"`, res.data);
  return EXIT.OK;
}

async function brainEntity(ctx: Ctx): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, 'usage: brain entity <id>');
  const res = await ctx.client.get<{ entity?: Record<string, unknown>; canonicalState?: string }>(`/api/brain/entities/${id}`);
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const e = (res.data.entity ?? res.data) as Record<string, unknown>;
  // Render each field readably — a nested canonicalRef {kind,id} becomes `kind:id`, never
  // `[object Object]`. JSON output (res.data) keeps canonicalRef structured, untouched.
  const rows = Object.entries(e).slice(0, 12).map(([k, v]): [string, string] => [k, formatRefValue(v)]);
  if (res.data.canonicalState) rows.push(['canonicalState', res.data.canonicalState]);
  const note = res.data.canonicalState === 'missing'
    ? '\nnote: the canonical source no longer exists — durable G-Brain provenance/knowledge is preserved.'
    : '';
  emit(ctx.io, ctx.config, kv(rows) + note, res.data);
  return EXIT.OK;
}

type Neighbor = { id: string; name?: string };
type Rel = { type?: string; fromEntityId?: string; toEntityId?: string };

async function brainNeighborhood(ctx: Ctx): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, 'usage: brain neighborhood <id>');
  const res = await ctx.client.get<{ entity?: Neighbor; relationships?: Rel[]; neighbors?: Neighbor[] }>(`/api/brain/entities/${id}/relationships`);
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const rels = res.data.relationships ?? [];
  // Resolve entity ids to readable names (focal entity + neighbors), so provenance edges
  // like `PRODUCED  Agent → Artifact` are legible instead of blank/opaque.
  const nameById = new Map<string, string>();
  for (const n of [res.data.entity, ...(res.data.neighbors ?? [])]) if (n?.id) nameById.set(n.id, n.name ?? n.id);
  const label = (eid?: string) => (eid ? nameById.get(eid) ?? eid : '—');
  const rows = rels.map((r) => [r.type ?? '—', label(r.fromEntityId), label(r.toEntityId)]);
  emit(ctx.io, ctx.config, rows.length ? table(['TYPE', 'FROM', 'TO'], rows) : 'no relationships', res.data);
  return EXIT.OK;
}

async function brainPromote(ctx: Ctx): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, 'usage: brain promote-artifact <artifactId>');
  if (!(await ensureConfirmed(ctx, `Promote artifact ${id} to G-Brain (explicit, idempotent).`))) {
    ctx.io.err('Aborted.');
    return EXIT.ACTION_NOT_COMPLETED;
  }
  const res = await ctx.client.post<{ error?: string }>(`/api/company-artifacts/${id}/promote-to-brain`, {});
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  emit(ctx.io, ctx.config, `artifact ${id} promoted to G-Brain.`, res.data);
  return EXIT.OK;
}

export async function brainCommand(ctx: Ctx): Promise<number> {
  switch (ctx.args[0]) {
    case 'search':
      return brainSearch(ctx);
    case 'entity':
      return brainEntity(ctx);
    case 'neighborhood':
      return brainNeighborhood(ctx);
    case 'promote-artifact':
      return brainPromote(ctx);
    default:
      return invalid(ctx, 'usage: brain search "<q>" | brain entity <id> | brain neighborhood <id> | brain promote-artifact <id>');
  }
}

export async function intelligenceCommand(ctx: Ctx): Promise<number> {
  const window = flag(ctx, 'window') ?? ctx.args[0];
  const qs = window ? `?window=${encodeURIComponent(window)}` : '';
  const res = await ctx.client.get<{ generatedAt: string; window: { key: string }; signals: { severity: string; title: string; summary: string }[] }>(`/api/company/intelligence${qs}`);
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const signals = res.data.signals ?? [];
  const lines = signals.length
    ? signals.map((s) => `  [${s.severity}] ${s.title} — ${s.summary}`).join('\n')
    : '  no signals in window';
  emit(ctx.io, ctx.config, `Company Intelligence (${res.data.window?.key ?? 'window'}) · ${signals.length} signal(s):\n${lines}`, res.data);
  return EXIT.OK;
}
