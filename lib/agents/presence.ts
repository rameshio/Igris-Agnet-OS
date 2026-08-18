/**
 * Agent Presence — pure operational-state model (UX Foundation U5, Part B).
 *
 * Presence is DATA, not animation: a small canonical state derived from REAL
 * run / node-run / approval rows. It is a read-only projection (no new table, no
 * fabricated status). The service (lib/agents/presence-service.ts) extracts
 * `PresenceSignal`s from authoritative rows; this module reduces them per agent
 * with a deterministic precedence + recency rule so the result is unit-testable.
 *
 * Canonical states (minimal by design — no invented "thinking"/"reading inbox"):
 *   working · waiting_approval · failed · idle
 */

export type PresenceState = 'idle' | 'working' | 'waiting_approval' | 'failed';

/**
 * How recent a signal must be to count as current presence. Guards both ways:
 *  - an ancient FAILURE never makes an inactive agent look permanently failed, and
 *  - a stale "running" node-run (e.g. a crashed run never marked terminal) decays
 *    to idle instead of showing a forever-Working agent.
 * 6h is generous for a demo/single-operator deployment; documented in ARCHITECTURE.
 */
export const PRESENCE_RECENCY_MS = 6 * 60 * 60 * 1000;

/** Modest client poll cadence (aligned with the U4 Activity stream). */
export const PRESENCE_POLL_MS = 6000;

/**
 * One authoritative fact about an agent at a point in time. `at` is an ISO
 * timestamp. Only these three kinds exist — idle is the ABSENCE of any signal.
 */
export type PresenceSignal = {
  kind: 'working' | 'waiting_approval' | 'failed';
  agentId: string;
  at: string;
  workflowId?: string;
  workflowName?: string;
  runId?: string;
};

export type AgentPresence = {
  agentId: string;
  state: PresenceState;
  /** Understandable without color (item 13): e.g. "Working · running in Gmail Daily". */
  label: string;
  workflowId?: string;
  workflowName?: string;
  runId?: string;
  /** Timestamp of the signal that produced this state (absent for idle). */
  since?: string;
};

/** Precedence when multiple fresh signals exist (item 8). Higher index wins. */
const PRECEDENCE: PresenceSignal['kind'][] = ['failed', 'waiting_approval', 'working'];

function wfLabel(s: PresenceSignal): string {
  return s.workflowName?.trim() || s.workflowId || 'a workflow';
}

function labelFor(kind: PresenceSignal['kind'], s: PresenceSignal): string {
  switch (kind) {
    case 'working':
      return `Working · running in ${wfLabel(s)}`;
    case 'waiting_approval':
      return `Waiting for approval · in ${wfLabel(s)}`;
    case 'failed':
      return 'Failed · latest run failed';
  }
}

const IDLE = (agentId: string): AgentPresence => ({ agentId, state: 'idle', label: 'Idle' });

/**
 * Reduce an agent's signals to one presence. Precedence:
 *   currently running node → waiting approval (agent's run) → latest failure → idle.
 * Only signals within `recencyMs` of `nowMs` count; within a kind the newest wins.
 * Future-dated signals (clock skew) are ignored.
 */
export function reducePresence(
  agentId: string,
  signals: PresenceSignal[],
  nowMs: number,
  recencyMs: number = PRESENCE_RECENCY_MS,
): AgentPresence {
  const fresh = signals.filter((s) => {
    const t = Date.parse(s.at);
    if (Number.isNaN(t)) return false;
    const age = nowMs - t;
    return age >= 0 && age <= recencyMs;
  });
  if (fresh.length === 0) return IDLE(agentId);

  // Highest-precedence kind that has any fresh signal; newest within that kind.
  for (let i = PRECEDENCE.length - 1; i >= 0; i--) {
    const kind = PRECEDENCE[i];
    const ofKind = fresh
      .filter((s) => s.kind === kind)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const pick = ofKind[0];
    if (pick) {
      const state: PresenceState = kind;
      return {
        agentId,
        state,
        label: labelFor(kind, pick),
        workflowId: pick.workflowId,
        workflowName: pick.workflowName,
        runId: pick.runId,
        since: pick.at,
      };
    }
  }
  return IDLE(agentId);
}

/**
 * Reduce a bag of signals (across many agents) into one presence per agent that
 * has at least one signal. Agents absent from the result are idle. Deterministic
 * ordering: non-idle first, then by agentId.
 */
export function reduceAllPresence(
  signals: PresenceSignal[],
  nowMs: number,
  recencyMs: number = PRESENCE_RECENCY_MS,
): AgentPresence[] {
  const byAgent = new Map<string, PresenceSignal[]>();
  for (const s of signals) {
    const list = byAgent.get(s.agentId) ?? [];
    list.push(s);
    byAgent.set(s.agentId, list);
  }
  const out: AgentPresence[] = [];
  for (const [agentId, list] of byAgent) {
    const p = reducePresence(agentId, list, nowMs, recencyMs);
    if (p.state !== 'idle') out.push(p);
  }
  return out.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}
