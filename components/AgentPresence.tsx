'use client';

/**
 * Agent presence UI (UX Foundation U5, Part B).
 *
 *  - <AgentPresencePoller> mounts ONCE per page: it seeds the shared store with
 *    server-computed presence and then polls the single read-only endpoint
 *    /api/agents/presence on a modest cadence — one request for the whole roster.
 *  - <AgentPresenceTag> renders one agent's presence dot + label, reading the
 *    shared store. Before the first snapshot lands it shows its deterministic
 *    `initial` prop (no hydration mismatch); AFTER a snapshot, an agent absent
 *    from it is idle (idle agents are omitted from the projection). Presence is
 *    DATA — no animation drives state.
 *
 * State is understandable without color (item 13): a glyph + a word precede the
 * dot, so the meaning survives for color-blind operators and in plain text.
 */
import { useEffect } from 'react';
import type { AgentPresence, PresenceState } from '@/lib/agents/presence';
import { PRESENCE_POLL_MS } from '@/lib/agents/presence';
import { hasPresenceSnapshot, setPresenceSnapshot, useAgentPresence } from '@/lib/agents/presence-store';

export function AgentPresencePoller({ initial }: { initial: AgentPresence[] }) {
  useEffect(() => {
    setPresenceSnapshot(initial); // seed once on mount (mirrors SSR), then poll

    let alive = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return; // never overlap requests
      inFlight = true;
      try {
        const res = await fetch('/api/agents/presence');
        if (!res.ok) return;
        const body = (await res.json()) as { presence?: AgentPresence[] };
        if (alive && Array.isArray(body.presence)) setPresenceSnapshot(body.presence);
      } catch {
        // read-only poll — a transient failure just keeps the last snapshot
      } finally {
        inFlight = false;
      }
    };

    const id = setInterval(load, PRESENCE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // Seed once on mount; `initial` is the server snapshot and never changes for this instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

const DOT_CLASS: Record<PresenceState, string> = {
  working: 'ok',
  waiting_approval: 'warn',
  failed: 'err',
  idle: 'off',
};

const GLYPH: Record<PresenceState, string> = {
  working: '●',
  waiting_approval: '⏸',
  failed: '✗',
  idle: '○',
};

const TEXT_CLASS: Record<PresenceState, string> = {
  working: 'text-os-ok',
  waiting_approval: 'text-os-warn',
  failed: 'text-os-err',
  idle: 'text-os-dim',
};

const idleFor = (agentId: string): AgentPresence => ({ agentId, state: 'idle', label: 'Idle' });

export function AgentPresenceTag({ agentId, initial }: { agentId: string; initial: AgentPresence }) {
  const live = useAgentPresence(agentId);
  // Before any snapshot: the deterministic server prop. After a snapshot: live, or
  // idle when the agent is absent (idle agents are omitted from the projection).
  const presence = live ?? (hasPresenceSnapshot() ? idleFor(agentId) : initial);
  const cls = DOT_CLASS[presence.state];

  return (
    <div className="flex items-center gap-1.5 font-mono text-[10px]" title={presence.label}>
      <span className={`dot ${cls}${presence.state === 'working' ? ' pulse' : ''}`} aria-hidden="true" />
      <span className={`min-w-0 truncate ${TEXT_CLASS[presence.state]}`}>
        {GLYPH[presence.state]} {presence.label}
      </span>
    </div>
  );
}
