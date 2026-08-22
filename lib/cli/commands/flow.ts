/**
 * `igris flow …` and `igris approvals` / `igris approval …` — control-surface commands
 * over the canonical Workflow (Phase A–C) and Human-Approval (Phase E) APIs. Running a
 * workflow reuses the existing published-version + validation authority; approvals route
 * through the backend-authoritative endpoints and never bypass Phase-E.
 */
import type { Ctx } from '@/lib/cli/context';
import { EXIT } from '@/lib/cli/exit';
import { emit, table, kv } from '@/lib/cli/output';
import { ensureConfirmed, flag, invalid, reportApiError } from '@/lib/cli/context';

type Workflow = { id: string; name: string; currentVersion: number | null; nodeCount?: number };

async function flowList(ctx: Ctx): Promise<number> {
  const res = await ctx.client.get<{ workflows: Workflow[] }>('/api/flows');
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const rows = res.data.workflows.map((w) => [w.id, (w.name ?? '').slice(0, 40), w.currentVersion == null ? 'draft' : `v${w.currentVersion}`, String(w.nodeCount ?? 0)]);
  emit(ctx.io, ctx.config, table(['ID', 'NAME', 'PUBLISHED', 'NODES'], rows), res.data);
  return EXIT.OK;
}

async function flowShow(ctx: Ctx): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, 'usage: flow show <id>');
  const res = await ctx.client.get<{ workflow?: Record<string, unknown> }>(`/api/flows/${id}`);
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const w = (res.data.workflow ?? res.data) as Record<string, unknown>;
  emit(ctx.io, ctx.config, kv([['ID', String(w.id)], ['Name', String(w.name)], ['Version', String(w.currentVersion ?? 'draft')], ['Description', String(w.description ?? '—')]]), res.data);
  return EXIT.OK;
}

async function flowRun(ctx: Ctx): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, 'usage: flow run <id> [--input "<text>"]');
  const input = flag(ctx, 'input') ?? '';
  if (!(await ensureConfirmed(ctx, `Run workflow ${id} (published version only). Phase-E approval nodes still pause for human sign-off.`))) {
    ctx.io.err('Aborted.');
    return EXIT.ACTION_NOT_COMPLETED;
  }
  const res = await ctx.client.post<{ ok?: boolean; runId?: string; status?: string; error?: string }>(`/api/flows/${id}/runs`, { input: { text: input } });
  if (!res.ok) return reportApiError(ctx, res.status, res.data); // 409 (unpublished) → ACTION_NOT_COMPLETED
  emit(ctx.io, ctx.config, `run started: ${res.data.runId} · status: ${res.data.status}`, res.data);
  return EXIT.OK;
}

export async function flowCommand(ctx: Ctx): Promise<number> {
  switch (ctx.args[0]) {
    case undefined:
    case 'list':
      return flowList(ctx);
    case 'show':
      return flowShow(ctx);
    case 'run':
      return flowRun(ctx);
    default:
      return invalid(ctx, 'usage: flow list | flow show <id> | flow run <id>');
  }
}

// ── Approvals (Phase E) ─────────────────────────────────────────────────────────
type Approval = { id: string; runId?: string; nodeId?: string; summary?: string; title?: string };

async function approvalsList(ctx: Ctx): Promise<number> {
  const res = await ctx.client.get<{ approvals: Approval[] }>('/api/flow-approvals');
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const rows = res.data.approvals.map((a) => [a.id, a.runId ?? '—', a.nodeId ?? '—', (a.title ?? a.summary ?? '').slice(0, 50)]);
  emit(ctx.io, ctx.config, rows.length ? table(['ID', 'RUN', 'NODE', 'SUMMARY'], rows) : 'no pending approvals', res.data);
  return EXIT.OK;
}

/** `approval approve|reject <id>` — routes through the backend-authoritative endpoint. */
export async function approvalDecision(ctx: Ctx, decision: 'approve' | 'reject'): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, `usage: approval ${decision} <id> [--note "<note>"]`);
  // Show the safe approval summary before mutating (never context_json internals).
  const info = await ctx.client.get<{ approval?: Approval }>(`/api/flow-approvals/${id}`);
  const summary = info.ok && info.data.approval ? `${info.data.approval.title ?? info.data.approval.summary ?? ''} (run ${info.data.approval.runId ?? '?'})` : id;
  if (!(await ensureConfirmed(ctx, `${decision === 'approve' ? 'APPROVE' : 'REJECT'} approval ${id}: ${summary}`))) {
    ctx.io.err('Aborted.');
    return EXIT.ACTION_NOT_COMPLETED;
  }
  const note = flag(ctx, 'note');
  const res = await ctx.client.post<{ ok?: boolean; error?: string }>(`/api/flow-approvals/${id}/${decision}`, note ? { note } : {});
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  emit(ctx.io, ctx.config, `approval ${id} ${decision === 'approve' ? 'approved' : 'rejected'}.`, res.data);
  return EXIT.OK;
}

export async function approvalsCommand(ctx: Ctx): Promise<number> {
  // `approvals` (list) or `approval approve|reject <id>`
  const sub = ctx.args[0];
  if (sub === 'approve') return approvalDecision(ctx, 'approve');
  if (sub === 'reject') return approvalDecision(ctx, 'reject');
  return approvalsList(ctx);
}
