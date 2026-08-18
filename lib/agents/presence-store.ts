/**
 * Client-side agent-presence store (UX Foundation U5, Part B).
 *
 * A single, tiny module store so ONE shared poll (the AgentPresencePoller) can
 * fan its result out to every agent card's presence tag — never a request per
 * agent. Mirrors the U1 Context Envelope store pattern (useSyncExternalStore, no
 * new dependency). Presence values are already safe (identifiers + labels only).
 *
 * SSR-safe: the server snapshot is always empty, so a presence tag renders its
 * server-computed `initial` prop deterministically and only swaps to live data
 * after the client poll lands (no hydration mismatch — the U1 hydration rule).
 */
import { useSyncExternalStore } from 'react';
import type { AgentPresence } from '@/lib/agents/presence';

let byAgent: Record<string, AgentPresence> = {};
let seeded = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

/** Replace the snapshot with the latest poll result (idle agents omitted). */
export function setPresenceSnapshot(list: AgentPresence[]): void {
  const next: Record<string, AgentPresence> = {};
  for (const p of list) next[p.agentId] = p;
  byAgent = next;
  seeded = true;
  emit();
}

export function getPresenceMap(): Record<string, AgentPresence> {
  return byAgent;
}
export function hasPresenceSnapshot(): boolean {
  return seeded;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const EMPTY: Record<string, AgentPresence> = {};

/**
 * Live presence for one agent, or `undefined` until the first client poll lands
 * (server + first client render both return undefined → caller falls back to its
 * deterministic `initial` prop).
 */
export function useAgentPresence(agentId: string): AgentPresence | undefined {
  const map = useSyncExternalStore(subscribe, getPresenceMap, () => EMPTY);
  return map[agentId];
}

/** Test-only reset so store state does not leak between tests. */
export function __resetPresenceStoreForTests(): void {
  byAgent = {};
  seeded = false;
  listeners.clear();
}
