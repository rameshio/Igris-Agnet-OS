/**
 * Conductor Ask (IGRIS CLI · `igris ask`) — a READ-ONLY operator query grounded in
 * canonical company state, answered by the configured model through the unified runtime.
 *
 * It is NOT a free-form LLM prompt: it assembles a SAFE, deterministic company-context
 * summary from existing services (active missions, pending approvals, Intelligence
 * signals) and asks the Executive-Manager/Conductor persona to answer over it. It never
 * mutates anything, never dispatches, never exposes secrets or approval `context_json`,
 * and routes through `routeModel` so there is NO silent provider fallback.
 */
import type { FounderDb } from '@/lib/db';
import type { LlmChatRequest } from '@/lib/connectors/llm';
import { listMissions } from '@/lib/company/service';
import { getCompanyIntelligence } from '@/lib/company/intelligence/service';
import { routeModel } from '@/lib/models/router';
import { parseModelSettings } from '@/lib/models/settings';
import { resolveEffectiveModel } from '@/lib/models/default-model';
import type { ModelRouteResult } from '@/lib/models/types';

const ACTIVE_MISSION_STATES = new Set(['draft', 'planned', 'active', 'in_progress', 'queued', 'running', 'blocked', 'waiting_approval']);
const MAX_MISSIONS = 8;
const MAX_SIGNALS = 8;

const CONDUCTOR_SYSTEM =
  'You are the IGRIS Executive Manager (Conductor), a read-only advisor. Answer the operator ' +
  'concisely and honestly using ONLY the company context provided. If the context does not ' +
  'contain the answer, say so plainly. Do not invent missions, tasks, numbers, or actions, and ' +
  'do not claim to have performed any action — you are advising, not executing.';

export type CompanyContext = {
  activeMissions: number;
  missions: { id: string; title: string; status: string }[];
  pendingApprovals: number;
  signals: { severity: string; summary: string }[];
  /** A compact, secret-free text block handed to the model. */
  text: string;
};

/** Build a bounded, safe company-context summary from canonical services. */
export function buildCompanyContext(db: FounderDb): CompanyContext {
  const all = listMissions(db);
  const active = all.filter((m) => ACTIVE_MISSION_STATES.has(m.status));
  const missions = active.slice(0, MAX_MISSIONS).map((m) => ({ id: m.id, title: m.title, status: m.status }));
  const pendingApprovals = db.flowApprovals.pending(100).length;

  let signals: { severity: string; summary: string }[] = [];
  try {
    const rank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    signals = getCompanyIntelligence(db, { window: '7d' }).signals
      .slice()
      .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))
      .slice(0, MAX_SIGNALS)
      .map((s) => ({ severity: s.severity, summary: s.summary }));
  } catch {
    signals = [];
  }

  const lines: string[] = [];
  lines.push(`Active missions: ${active.length} (of ${all.length} total).`);
  for (const m of missions) lines.push(`- Mission "${m.title}" [${m.status}]`);
  lines.push(`Pending human approvals: ${pendingApprovals}.`);
  if (signals.length) {
    lines.push('Top intelligence signals (7d):');
    for (const s of signals) lines.push(`- (${s.severity}) ${s.summary}`);
  } else {
    lines.push('No intelligence signals in the last 7d.');
  }

  return { activeMissions: active.length, missions, pendingApprovals, signals, text: lines.join('\n') };
}

export type AskResult = {
  answer: string;
  model: string;
  adapter: string;
  context: CompanyContext;
  usage?: ModelRouteResult['usage'];
};

/**
 * Answer an operator question over safe company context. Read-only. `model` optionally
 * overrides the effective model (run override → agent → global default → brain).
 */
export async function askConductor(db: FounderDb, opts: { question: string; model?: string }): Promise<AskResult> {
  const question = (opts.question ?? '').trim();
  if (!question) throw new Error('a question is required');

  const context = buildCompanyContext(db);
  const modelString = resolveEffectiveModel(db, { override: opts.model });
  const settings = parseModelSettings(modelString);

  const req: LlmChatRequest = {
    system: CONDUCTOR_SYSTEM,
    messages: [{ role: 'user', content: `Company context:\n${context.text}\n\nOperator question: ${question}` }],
  };

  const res = await routeModel(db, settings, req); // ModelRouteError bubbles up — no silent fallback
  return { answer: res.text, model: modelString || 'hermes', adapter: res.adapter, context, usage: res.usage };
}
