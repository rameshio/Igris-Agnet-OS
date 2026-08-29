/**
 * `igris mission …`, `igris task …`, `igris artifact …` — control-surface commands over
 * the canonical Mission/Task/Artifact APIs. Reads are direct; mutations show a preview
 * and require confirmation (or `--yes`). Dispatch preserves all server-side capability/
 * tool preflight and Phase-E approval authority — the CLI only asks the server to act.
 */
import type { Ctx } from '@/lib/cli/context';
import { EXIT } from '@/lib/cli/exit';
import { emit, table, kv } from '@/lib/cli/output';
import { ensureConfirmed, flag, invalid, reportApiError } from '@/lib/cli/context';

// ── Missions ──────────────────────────────────────────────────────────────────
type Mission = { id: string; title: string; status: string; priority?: string; objective?: string };

async function missionList(ctx: Ctx): Promise<number> {
  const res = await ctx.client.get<{ missions: Mission[] }>('/api/missions');
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const rows = res.data.missions.map((m) => [m.id, (m.title ?? '').slice(0, 48), m.status, m.priority ?? '']);
  emit(ctx.io, ctx.config, table(['ID', 'TITLE', 'STATUS', 'PRIORITY'], rows), res.data);
  return EXIT.OK;
}

async function missionShow(ctx: Ctx): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, 'usage: mission show <id>');
  const res = await ctx.client.get<{ mission: Mission; summary?: { total: number; byStatus: Record<string, number> } }>(`/api/missions/${id}`);
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const m = res.data.mission;
  const counts = res.data.summary?.byStatus ?? {};
  const human = kv([
    ['Mission', m.title],
    ['ID', m.id],
    ['Status', m.status],
    ['Priority', m.priority ?? '—'],
    ['Tasks', res.data.summary?.total ?? 0],
    ['Breakdown', Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(' ') || '—'],
  ]);
  emit(ctx.io, ctx.config, human, res.data);
  return EXIT.OK;
}

async function missionCreate(ctx: Ctx): Promise<number> {
  const title = ctx.args[1];
  if (!title) return invalid(ctx, 'usage: mission create "<title>" [--objective "<objective>"]');
  const objective = flag(ctx, 'objective');
  if (!(await ensureConfirmed(ctx, `Create mission: "${title}"${objective ? ` (objective: ${objective})` : ''}`))) {
    ctx.io.err('Aborted.');
    return EXIT.ACTION_NOT_COMPLETED;
  }
  const res = await ctx.client.post<{ mission?: Mission; error?: string }>('/api/missions', { title, objective });
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  emit(ctx.io, ctx.config, `created mission ${res.data.mission?.id} — "${res.data.mission?.title}"`, res.data);
  return EXIT.OK;
}

async function missionMutation(ctx: Ctx, verb: 'plan' | 'archive'): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, `usage: mission ${verb} <id>`);
  const preview = verb === 'plan' ? `Plan mission ${id} (decompose into tasks).` : `Archive mission ${id}.`;
  if (!(await ensureConfirmed(ctx, preview))) {
    ctx.io.err('Aborted.');
    return EXIT.ACTION_NOT_COMPLETED;
  }
  const res = await ctx.client.post<{ error?: string }>(`/api/missions/${id}/${verb}`, {});
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  emit(ctx.io, ctx.config, `mission ${id} ${verb === 'plan' ? 'planned' : 'archived'}.`, res.data);
  return EXIT.OK;
}

async function missionStep(ctx: Ctx): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, 'usage: mission step <id> [--max N]');
  const maxRaw = flag(ctx, 'max');
  const maxSteps = maxRaw ? Number(maxRaw) : undefined;
  if (!(await ensureConfirmed(ctx, `Run one bounded Executive-Manager tick on mission ${id}${maxSteps ? ` (max ${maxSteps} steps)` : ''}. Approvals still require explicit human sign-off.`))) {
    ctx.io.err('Aborted.');
    return EXIT.ACTION_NOT_COMPLETED;
  }
  const res = await ctx.client.post<{ dispatched?: unknown[]; report?: { status: string }; error?: string }>(`/api/missions/${id}/manager-step`, maxSteps ? { maxSteps } : {});
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const dispatched = res.data.dispatched?.length ?? 0;
  emit(ctx.io, ctx.config, `manager tick complete — ${dispatched} task(s) actioned · mission status: ${res.data.report?.status ?? 'unknown'}`, res.data);
  return EXIT.OK;
}

async function missionCommand(ctx: Ctx): Promise<number> {
  switch (ctx.args[0]) {
    case undefined:
    case 'list':
      return missionList(ctx);
    case 'show':
      return missionShow(ctx);
    case 'create':
      return missionCreate(ctx);
    case 'plan':
      return missionMutation(ctx, 'plan');
    case 'archive':
      return missionMutation(ctx, 'archive');
    case 'step':
      return missionStep(ctx);
    default:
      return invalid(ctx, `unknown mission subcommand "${ctx.args[0]}" (list|show|create|plan|step|archive)`);
  }
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
type Task = {
  id: string; title: string; status: string; requiredCapabilities?: string[]; assignedAgentId?: string;
  attemptCount?: number; maxAttempts?: number; lastFailureCode?: string; lastFailureClass?: string; lastFailureSummary?: string;
};
type RetryDecision = { decision: string; class: string; reason: string; remainingAttempts: number };
type RetryTiming = { nextRetryAt: string | null; retryDue: boolean; retryAfterMs: number };
type ReassignmentDecision = { decision: string; reason: string; candidateCount: number; toAgentId?: string };

async function taskList(ctx: Ctx): Promise<number> {
  const mission = flag(ctx, 'mission');
  if (!mission) return invalid(ctx, 'usage: task list --mission <missionId>');
  const res = await ctx.client.get<{ tasks: Task[] }>(`/api/missions/${mission}/tasks`);
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const rows = res.data.tasks.map((t) => [t.id, (t.title ?? '').slice(0, 40), t.status, (t.requiredCapabilities ?? []).join(',')]);
  emit(ctx.io, ctx.config, table(['ID', 'TITLE', 'STATUS', 'CAPABILITIES'], rows), res.data);
  return EXIT.OK;
}

async function taskShow(ctx: Ctx): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, 'usage: task show <id>');
  const res = await ctx.client.get<{ task: Task; prerequisitesSatisfied: boolean; retry: RetryDecision | null; retryTiming: RetryTiming | null; reassignment: ReassignmentDecision | null }>(`/api/company-tasks/${id}`);
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const t = res.data.task;
  const rows: [string, string][] = [
    ['Task', t.title],
    ['ID', t.id],
    ['Status', t.status],
    ['Capabilities', (t.requiredCapabilities ?? []).join(', ') || '—'],
    ['Assigned', t.assignedAgentId ?? '—'],
    ['Prereqs satisfied', String(res.data.prerequisitesSatisfied)],
    ['Attempts', `${t.attemptCount ?? 0}/${t.maxAttempts ?? 3}`],
  ];
  if (t.status === 'failed') {
    rows.push(['Last failure', `${t.lastFailureClass ?? 'unknown'}${t.lastFailureCode ? ` (${t.lastFailureCode})` : ''}`]);
    if (t.lastFailureSummary) rows.push(['Failure detail', t.lastFailureSummary]);
    if (res.data.retry) rows.push(['Retry', `${res.data.retry.decision} — ${res.data.retry.reason}`]);
    // Reliability G4: retry backoff timing (automatic retries wait until due; explicit retry may go early).
    const timing = res.data.retryTiming;
    if (timing && timing.nextRetryAt) {
      rows.push(['Next retry', timing.retryDue ? 'due now' : `${timing.nextRetryAt} (in ${Math.ceil(timing.retryAfterMs / 1000)}s)`]);
    }
    if (res.data.reassignment) {
      const r = res.data.reassignment;
      const target = r.decision === 'REASSIGN_ALLOWED' && r.toAgentId ? ` → ${r.toAgentId}` : '';
      rows.push(['Reassignment', `${r.decision}${target} — ${r.reason} (${r.candidateCount} alt)`]);
    }
  }
  emit(ctx.io, ctx.config, kv(rows), res.data);
  return EXIT.OK;
}

async function taskRetry(ctx: Ctx): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, 'usage: task retry <id>');
  // Preview: show the current failure + retry eligibility before mutating.
  const pre = await ctx.client.get<{ task: Task; retry: RetryDecision | null }>(`/api/company-tasks/${id}`);
  if (!pre.ok) return reportApiError(ctx, pre.status, pre.data);
  const t = pre.data.task;
  if (t.status !== 'failed') {
    ctx.io.err(`error: task ${id} is ${t.status}, not failed — nothing to retry.`);
    return EXIT.ACTION_NOT_COMPLETED;
  }
  const decision = pre.data.retry;
  ctx.io.out(`Task ${id} failed: ${t.lastFailureClass ?? 'unknown'}${t.lastFailureCode ? ` (${t.lastFailureCode})` : ''} · attempts ${t.attemptCount ?? 0}/${t.maxAttempts ?? 3}`);
  if (decision && decision.decision !== 'RETRY_ALLOWED') {
    ctx.io.err(`error: not retryable — ${decision.decision}: ${decision.reason}`);
    return EXIT.ACTION_NOT_COMPLETED;
  }
  if (!(await ensureConfirmed(ctx, `Retry task ${id}. Controlled failed→queued, then dispatch (server enforces tool preflight + Phase-E approval).`))) {
    ctx.io.err('Aborted.');
    return EXIT.ACTION_NOT_COMPLETED;
  }
  const res = await ctx.client.post<{ ok?: boolean; retry?: RetryDecision; dispatch?: { outcome?: string }; error?: string }>(`/api/company-tasks/${id}/retry`, {});
  if (!res.ok) {
    // 409 carries the retry decision (human action required / exhausted).
    if (res.status === 409 && res.data.retry) {
      ctx.io.err(`error: not retryable — ${res.data.retry.decision}: ${res.data.retry.reason}`);
      return EXIT.ACTION_NOT_COMPLETED;
    }
    return reportApiError(ctx, res.status, res.data);
  }
  const outcome = res.data.dispatch?.outcome ?? 'queued';
  emit(ctx.io, ctx.config, `retry dispatched — outcome: ${outcome}`, res.data);
  return EXIT.OK;
}

type Eligible = { agents: { agentId: string; name: string }[]; toolGaps: { capabilityId: string; reason: string }[] };

async function taskEligible(ctx: Ctx): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, 'usage: task eligible <id>');
  const res = await ctx.client.get<Eligible>(`/api/company-tasks/${id}/eligible-agents`);
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const agentLines = res.data.agents.length ? res.data.agents.map((a) => `  - ${a.name} (${a.agentId})`).join('\n') : '  (none eligible)';
  const gapLines = res.data.toolGaps.length ? '\nTool gaps:\n' + res.data.toolGaps.map((g) => `  - ${g.reason}`).join('\n') : '';
  emit(ctx.io, ctx.config, `Eligible agents:\n${agentLines}${gapLines}`, res.data);
  return EXIT.OK;
}

async function taskDispatch(ctx: Ctx): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, 'usage: task dispatch <id>');
  // Preview via the canonical eligible-agents read so the operator sees the target/gap.
  const pre = await ctx.client.get<Eligible>(`/api/company-tasks/${id}/eligible-agents`);
  const previewTarget = pre.ok && pre.data.agents.length ? `→ ${pre.data.agents[0].name}` : pre.ok && pre.data.toolGaps.length ? `(tool gap: ${pre.data.toolGaps[0].reason})` : '';
  if (!(await ensureConfirmed(ctx, `Dispatch task ${id} ${previewTarget}. Server enforces capability/tool preflight and Phase-E approval.`))) {
    ctx.io.err('Aborted.');
    return EXIT.ACTION_NOT_COMPLETED;
  }
  const res = await ctx.client.post<{ outcome?: string; toolGap?: string[]; error?: string }>(`/api/company-tasks/${id}/dispatch`, {});
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  const outcome = res.data.outcome ?? 'unknown';
  emit(ctx.io, ctx.config, `dispatch outcome: ${outcome}${res.data.toolGap ? ` · tool gap: ${res.data.toolGap.join(', ')}` : ''}`, res.data);
  // A gap / dependency wait / approval means the action did not complete execution.
  return ['capability_gap', 'waiting_dependency'].includes(outcome) ? EXIT.ACTION_NOT_COMPLETED : EXIT.OK;
}

async function taskCommand(ctx: Ctx): Promise<number> {
  switch (ctx.args[0]) {
    case undefined:
    case 'list':
      return taskList(ctx);
    case 'show':
      return taskShow(ctx);
    case 'eligible':
      return taskEligible(ctx);
    case 'dispatch':
      return taskDispatch(ctx);
    case 'retry':
      return taskRetry(ctx);
    default:
      return invalid(ctx, `unknown task subcommand "${ctx.args[0]}" (list|show|eligible|dispatch|retry)`);
  }
}

// ── Artifacts ─────────────────────────────────────────────────────────────────
async function artifactShow(ctx: Ctx): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, 'usage: artifact show <id>');
  const res = await ctx.client.get<{ artifact?: { title: string; type: string; content?: unknown; summary?: string; producedByAgentId?: string } }>(`/api/company-artifacts/${id}`);
  if (!res.ok) {
    // A deleted Company Artifact (e.g. mission cleanup) fails clearly — and we never
    // substitute promoted G-Brain content for it. The canonical ownership stays distinct.
    if (res.status === 404) {
      ctx.io.err(`error: artifact ${id} not found in Company Core (it may have been cleaned up).`);
      ctx.io.err(`Promoted G-Brain knowledge/provenance may still exist. Try:  igris brain search "${id}"`);
      return EXIT.INVALID_INPUT;
    }
    return reportApiError(ctx, res.status, res.data);
  }
  const a = res.data.artifact!;
  const content = typeof a.content === 'string' ? a.content : JSON.stringify(a.content, null, 2);
  const human = [kv([['Artifact', a.title], ['Type', a.type], ['Produced by', a.producedByAgentId ?? '—']]), '', a.summary ? `Summary: ${a.summary}\n` : '', 'Result:', content ?? '—'].join('\n');
  emit(ctx.io, ctx.config, human, res.data);
  return EXIT.OK;
}

async function artifactPromote(ctx: Ctx): Promise<number> {
  const id = ctx.args[1];
  if (!id) return invalid(ctx, 'usage: artifact promote <id>');
  if (!(await ensureConfirmed(ctx, `Promote artifact ${id} to G-Brain (canonical, idempotent).`))) {
    ctx.io.err('Aborted.');
    return EXIT.ACTION_NOT_COMPLETED;
  }
  const res = await ctx.client.post<{ error?: string }>(`/api/company-artifacts/${id}/promote-to-brain`, {});
  if (!res.ok) return reportApiError(ctx, res.status, res.data);
  emit(ctx.io, ctx.config, `artifact ${id} promoted to G-Brain.`, res.data);
  return EXIT.OK;
}

async function artifactCommand(ctx: Ctx): Promise<number> {
  switch (ctx.args[0]) {
    case 'show':
      return artifactShow(ctx);
    case 'promote':
      return artifactPromote(ctx);
    default:
      return invalid(ctx, 'usage: artifact show <id> | artifact promote <id>');
  }
}

export { missionCommand, taskCommand, artifactCommand };
