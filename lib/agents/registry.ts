/**
 * The Company Registry — the canonical view of the agent workforce.
 *
 * The full live roster = the code-defined built-ins (lib/agents/real.ts) plus
 * every client-created custom agent stored in the DB. Routes that run, chat
 * with, or broadcast to agents resolve against this combined set so a custom
 * agent is a first-class citizen everywhere a built-in is.
 *
 * F0.1 adds a Capability layer over this same registry so future Manager logic
 * (F1) can ask "which agents can perform capability X?" by CAPABILITY rather than
 * loading/reasoning over the whole roster. This is registry/data/resolution
 * ONLY — nothing here starts, assigns, delegates, or creates anything.
 */
import type { FounderDb } from '@/lib/db';
import { realAgents } from '@/lib/agents/real';
import { customRuntimeAgents } from '@/lib/agents/custom';
import type { RuntimeAgent } from '@/lib/agents/runtime';
import {
  resolveAgents,
  normalizeCapabilityId,
  type AgentMatch,
  type Capability,
  type ResolveMode,
} from '@/lib/agents/capabilities';

export function allRuntimeAgents(db: FounderDb): RuntimeAgent[] {
  return [...realAgents, ...customRuntimeAgents(db)];
}

/** One agent by its canonical id (built-in or custom), or undefined. */
export function getAgentById(db: FounderDb, id: string): RuntimeAgent | undefined {
  return allRuntimeAgents(db).find((a) => a.id === id);
}

/**
 * The Executive Manager agent (Architecture V2 F1) — the evolved Conductor. It is
 * the single `executive_manager` in the runtime registry (no duplicate id). The F1
 * manager service orchestrates through THIS agent + the existing runtime.
 */
export function getExecutiveManager(db: FounderDb): RuntimeAgent | undefined {
  return allRuntimeAgents(db).find((a) => a.role === 'executive_manager');
}

/** The capability DEFINITIONS an agent is assigned (joined to the catalog). */
export function getCapabilitiesForAgent(db: FounderDb, agentId: string): Capability[] {
  return db.agentCapabilities
    .forAgent(agentId)
    .map((ac) => db.capabilities.get(ac.capabilityId))
    .filter((c): c is Capability => c !== null);
}

/** Registered agents (safe id+name) currently assigned a given capability. */
export function getAgentsForCapability(db: FounderDb, capabilityId: string): { agentId: string; name: string }[] {
  const cap = normalizeCapabilityId(capabilityId);
  const known = new Map(allRuntimeAgents(db).map((a) => [a.id, a.name]));
  return db.agentCapabilities
    .forCapability(cap)
    .filter((ac) => known.has(ac.agentId)) // ignore assignments to agents that no longer exist
    .map((ac) => ({ agentId: ac.agentId, name: known.get(ac.agentId)! }));
}

/**
 * Resolve eligible agents for the required capabilities (default mode `all`).
 * Deterministic, exact-id matching only — the reusable seam the F1 Manager will
 * call. Returns SAFE metadata only (id/name/matched/missing/proficiency/score);
 * it never starts, assigns, or delegates work.
 */
export function resolveAgentsForCapabilities(
  db: FounderDb,
  required: string[],
  opts: { mode?: ResolveMode } = {},
): AgentMatch[] {
  const agents = allRuntimeAgents(db).map((a) => ({ id: a.id, name: a.name }));
  return resolveAgents({ agents, assignments: db.agentCapabilities.all(), required, mode: opts.mode });
}
