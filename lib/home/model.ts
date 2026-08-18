/**
 * Commander Home — pure view model (UX Foundation U6).
 *
 * Home is the AI-native OPERATING SURFACE: a briefing + the Commander entry + a
 * summary of REAL operational state. It is NOT a second dashboard and NOT a
 * second source of truth — every field is derived (by the service) from existing
 * authoritative state (U4 Activity, U5 approvals/presence, run/agent repos, the
 * cheap Hermes meta signals). This module is pure + framework-free so the
 * greeting, the summary line, the first-run rule, and the Hermes status
 * classification are all unit-testable with no DB/React.
 *
 * Privacy: every shape here is identifiers + safe labels + coarse status only —
 * never secrets, tokens, prompts, LLM outputs, tool args, email bodies, or raw
 * context_json (the approval items come from the U5 SAFE projection).
 */
import type { ActivityEvent } from '@/lib/activity/model';
import type { ApprovalRisk } from '@/lib/flows/approval-view';

// ── Bounds (Home is a summary — never a giant payload) ───────────────────────
export const HOME_NEEDS_YOU_CAP = 5;
export const HOME_RUNNING_CAP = 5;
export const HOME_RECENT_CAP = 5;
/** A failure counts as "recent" (actionable now) within this window. */
export const HOME_RECENT_FAILURE_MS = 24 * 60 * 60 * 1000;
/** Modest client poll cadence for Home. */
export const HOME_POLL_MS = 8000;

// ── Item shapes (safe subsets only) ──────────────────────────────────────────

/** A pending approval, from the U5 safe projection (no context_json). */
export type HomeApprovalItem = {
  approvalId: string;
  title: string;
  workflowId: string;
  workflowName?: string;
  runId: string;
  risk: ApprovalRisk;
};

/** A genuinely-active workflow run. */
export type HomeRunItem = {
  runId: string;
  workflowId: string;
  workflowName?: string;
  status: string; // 'running' (waiting_approval is surfaced under Needs You, not here)
  startedAt: string | null;
};

/** A recent failure that needs attention. */
export type HomeAttentionItem = {
  kind: 'run_failed';
  runId: string;
  workflowId: string;
  workflowName?: string;
  at: string;
  detail?: string; // short, safe error label (already truncated upstream)
};

export type HomeHermesState = 'ok' | 'warn' | 'err' | 'unknown' | 'stub';
export type HomeSystemStatus = {
  hermes: { state: HomeHermesState; label: string };
  /** Real configured runtime agents (built-in + custom). */
  agentCount: number;
  /** In-flight runs: running OR waiting on a human approval. */
  activeRunCount: number;
  /** Pending approvals only. */
  pendingApprovalCount: number;
  /** Failed runs within HOME_RECENT_FAILURE_MS (a defined recent window, not all history). */
  recentFailureCount: number;
};

export type HomeSnapshot = {
  pendingApprovals: HomeApprovalItem[];
  attention: HomeAttentionItem[];
  running: HomeRunItem[];
  recent: ActivityEvent[];
  system: HomeSystemStatus;
  /** True only when the workspace is genuinely empty (no workflows/custom agents/runs). */
  firstRun: boolean;
  generatedAt: string;
};

// ── Navigation targets (existing canonical surfaces — no new deep-link routing) ──
export const HOME_TARGETS = {
  approval: '/approvals',
  approvalsAll: '/approvals',
  failure: '/flows',
  running: '/flows',
  hermes: '/settings',
  agents: '/agents',
} as const;

// ── Greeting (deterministic; local-time-aware on the client) ─────────────────

export type Greeting = 'Late night' | 'Good morning' | 'Good afternoon' | 'Good evening';

/** Pure greeting from an hour (0–23). Boundaries: <5 late, <12 morning, <18 afternoon, else evening. */
export function greetingForHour(hour: number): Greeting {
  if (hour < 5) return 'Late night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// ── Attention summary line ("3 approvals need you · 1 running · 1 failure") ──

export type SummaryTone = 'warn' | 'accent' | 'err' | 'dim';
export type SummaryLine = { text: string; tone: SummaryTone };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The one-glance briefing line. Empty state collapses to a single reassuring
 * line — never fabricated activity.
 */
export function homeSummaryLines(snapshot: Pick<HomeSnapshot, 'pendingApprovals' | 'running' | 'attention'>): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const approvals = snapshot.pendingApprovals.length;
  const running = snapshot.running.length;
  const failures = snapshot.attention.length;

  if (approvals > 0) lines.push({ text: `${plural(approvals, 'approval')} need you`, tone: 'warn' });
  if (running > 0) lines.push({ text: `${plural(running, 'workflow')} running`, tone: 'accent' });
  if (failures > 0) lines.push({ text: `${plural(failures, 'recent failure')}`, tone: 'err' });

  if (lines.length === 0) lines.push({ text: "You're all caught up.", tone: 'dim' });
  return lines;
}

// ── First-run detection ──────────────────────────────────────────────────────

/** Genuinely empty workspace ⇒ show a compact first mission instead of empty widgets. */
export function isFirstRun(counts: { workflows: number; customAgents: number; runs: number }): boolean {
  return counts.workflows === 0 && counts.customAgents === 0 && counts.runs === 0;
}

// ── Hermes status (CHEAP — from cached meta only; never probes the CLI) ───────

/**
 * Classify Hermes status from cheap cached signals only (the configured brain +
 * the last runtime check recorded by the Settings panel). It NEVER probes the
 * binary, so it is safe to poll. Honest rule: **never green when unknown** —
 * `ok` requires a recorded successful check that is at least as new as the last
 * check; a newer check without success ⇒ `err`; no check ever ⇒ `unknown`.
 */
export function homeHermesStatus(input: {
  provider: string; // activeLlmProviderName(): 'gateway' | 'hermes' | 'stub' | ...
  transport?: string | null; // 'acp' | 'serve'
  lastCheckAt?: string | null;
  lastSuccessAt?: string | null;
}): { state: HomeHermesState; label: string } {
  const provider = (input.provider || 'gateway').toLowerCase();
  if (provider === 'stub') return { state: 'stub', label: 'Stub brain' };

  const providerLabel = provider === 'hermes' ? 'Hermes' : provider.charAt(0).toUpperCase() + provider.slice(1);
  const withTransport =
    provider === 'hermes' && input.transport ? `${providerLabel} · ${input.transport.toUpperCase()}` : providerLabel;

  if (!input.lastCheckAt) return { state: 'unknown', label: `${withTransport} · unchecked` };
  const succeeded = !!input.lastSuccessAt && input.lastSuccessAt >= input.lastCheckAt;
  if (succeeded) return { state: 'ok', label: withTransport };
  return { state: 'err', label: `${withTransport} · unreachable` };
}
