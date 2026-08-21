/**
 * Capability model + resolver (Architecture V2 · F0.1).
 *
 * A **Capability** = WHAT WORK an agent can perform (`domain.action`, e.g.
 * `email.summarize`, `research.web`). It is deliberately DISTINCT from:
 *   • Tool   — an external/local mechanism that may SUPPORT a capability (Gmail)
 *   • Skill  — reusable instructions/behavior that may SUPPORT it
 *   • Model  — the intelligence the agent thinks on
 *   • Permission — whether the agent is AUTHORIZED to do it (Approval governs that)
 * A Capability says "CAN perform", never "MAY perform" and never "GO do it".
 *
 * This module is PURE (only `zod`, no DB/React) so the id rules and the resolver
 * are fully unit-testable without SQLite. The Company Registry (registry.ts)
 * composes this with the repos; F1 Manager will reuse the resolver unchanged.
 *
 * F0.1 scope: registry / data / resolution only. NO task assignment, NO
 * delegation, NO agent creation, NO execution. Resolution is deterministic —
 * there is NO LLM/embedding matching here.
 */
import { z } from 'zod';

export type CapabilitySource = 'explicit' | 'derived';

export type Capability = {
  id: string; // canonical `domain.action`
  name: string;
  description?: string;
  domain?: string;
  createdAt: string;
};

export type AgentCapability = {
  agentId: string; // canonical RuntimeAgent id (built-in OR custom-*); never an FK
  capabilityId: string;
  proficiency: number | null; // 0–100 config metadata (NOT measured performance); null = unrated
  source: CapabilitySource; // explicit assignment vs a deterministic derived one
  createdAt: string;
};

// ── Capability id rules (stable, machine-readable — never a display name) ─────

/** `domain.action` (≥2 lowercase alphanumeric/hyphen segments, dot-separated). */
export const CAPABILITY_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
export const CAPABILITY_ID_MAX = 120;

/** Lowercase + trim. Normalization only — does NOT validate. */
export function normalizeCapabilityId(raw: string): string {
  return raw.trim().toLowerCase();
}

/** True when `id` is already a valid canonical id (call after normalize). */
export function isValidCapabilityId(id: string): boolean {
  return id.length > 0 && id.length <= CAPABILITY_ID_MAX && CAPABILITY_ID_RE.test(id);
}

/** The domain segment (before the first dot). */
export function domainOf(id: string): string {
  return id.split('.')[0];
}

const CapabilityIdSchema = z
  .string()
  .max(CAPABILITY_ID_MAX * 2)
  .transform(normalizeCapabilityId)
  .refine(isValidCapabilityId, 'invalid capability id — use lowercase `domain.action` (e.g. research.web)');

/** Validate + normalize a capability definition (API/DB boundary). */
export const CapabilityInputSchema = z.object({
  id: CapabilityIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
  domain: z.string().trim().max(60).optional(),
});
export type CapabilityInput = z.infer<typeof CapabilityInputSchema>;

/** Validate an assignment of a capability to an agent (proficiency is optional metadata). */
export const AgentCapabilityAssignSchema = z.object({
  capabilityId: CapabilityIdSchema,
  proficiency: z.number().int().min(0).max(100).optional(),
  source: z.enum(['explicit', 'derived']).default('explicit'),
});
export type AgentCapabilityAssignInput = z.infer<typeof AgentCapabilityAssignSchema>;

// ── Resolver (pure, deterministic) ───────────────────────────────────────────

export type ResolveMode = 'all' | 'any';

/** Safe agent reference the resolver ranks — identifiers/labels ONLY (no prompts/tools/secrets). */
export type ResolverAgentRef = { id: string; name: string };

/** A capability assignment, as the resolver consumes it (proficiency/source optional). */
export type AgentCapabilityLite = {
  agentId: string;
  capabilityId: string;
  proficiency?: number | null;
  source?: CapabilitySource;
};

export type AgentMatch = {
  agentId: string;
  name: string;
  matchedCapabilities: string[];
  missingCapabilities: string[];
  /** Avg configured proficiency across matched caps that supplied one; null if none did. */
  proficiency: number | null;
  /** Deterministic coverage score (matched-capability count). Higher = better. */
  score: number;
};

/** Missing proficiency counts as this neutral baseline for RANKING only (never surfaced). */
const NEUTRAL_PROFICIENCY = 50;

/**
 * Resolve which agents can perform the required capabilities. `all` (default):
 * an agent must satisfy EVERY required capability. `any`: at least one (discovery).
 * Deterministic ranking: coverage → explicit-over-derived → proficiency → name → id.
 * Exact capability-id matching only — no semantic/LLM inference.
 */
export function resolveAgents(input: {
  agents: ResolverAgentRef[];
  assignments: AgentCapabilityLite[];
  required: string[];
  mode?: ResolveMode;
  /**
   * Optional tool-awareness (Architecture V2 · tool-backed eligibility). When provided,
   * a required capability counts as satisfied only if the agent ALSO passes this check —
   * i.e. actually has the concrete tool the capability requires. Absent → capability-only
   * matching (unchanged). The predicate is generic; the resolver stays free of tool/wiring
   * knowledge (the registry supplies the real check).
   */
  toolCheck?: (agentId: string, capabilityId: string) => boolean;
}): AgentMatch[] {
  const mode = input.mode ?? 'all';
  const required = [...new Set(input.required.map(normalizeCapabilityId))].filter(isValidCapabilityId);
  if (required.length === 0) return [];

  // Index assignments by agent → (capabilityId → assignment).
  const byAgent = new Map<string, Map<string, AgentCapabilityLite>>();
  for (const a of input.assignments) {
    const capabilityId = normalizeCapabilityId(a.capabilityId);
    let caps = byAgent.get(a.agentId);
    if (!caps) {
      caps = new Map();
      byAgent.set(a.agentId, caps);
    }
    caps.set(capabilityId, { ...a, capabilityId });
  }

  type Ranked = AgentMatch & { _explicit: number; _avgRank: number };
  const ranked: Ranked[] = [];

  for (const agent of input.agents) {
    const caps = byAgent.get(agent.id) ?? new Map<string, AgentCapabilityLite>();
    const matched: string[] = [];
    const missing: string[] = [];
    // A capability is truly matched only when the agent holds the label AND (if a tool
    // check is supplied) actually has the tool it requires. A has-label-but-no-tool
    // capability is NOT matched → the agent is not falsely eligible.
    for (const req of required) {
      const satisfied = caps.has(req) && (!input.toolCheck || input.toolCheck(agent.id, req));
      (satisfied ? matched : missing).push(req);
    }

    const eligible = mode === 'all' ? missing.length === 0 : matched.length > 0;
    if (!eligible) continue;

    const supplied = matched.map((c) => caps.get(c)!.proficiency).filter((p): p is number => typeof p === 'number');
    const proficiency = supplied.length ? Math.round(supplied.reduce((s, p) => s + p, 0) / supplied.length) : null;
    const explicit = matched.filter((c) => (caps.get(c)!.source ?? 'explicit') === 'explicit').length;
    const avgRank = matched.length
      ? matched.reduce((s, c) => {
          const p = caps.get(c)!.proficiency;
          return s + (typeof p === 'number' ? p : NEUTRAL_PROFICIENCY);
        }, 0) / matched.length
      : 0;

    ranked.push({
      agentId: agent.id,
      name: agent.name,
      matchedCapabilities: matched,
      missingCapabilities: missing,
      proficiency,
      score: matched.length,
      _explicit: explicit,
      _avgRank: avgRank,
    });
  }

  ranked.sort(
    (a, b) =>
      b.score - a.score || // 1. capability coverage
      b._explicit - a._explicit || // 2. explicit preferred over derived
      b._avgRank - a._avgRank || // 3. configured proficiency
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || // 4. stable name tie-break
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0), // 5. stable id tie-break
  );

  return ranked.map(({ _explicit, _avgRank, ...m }) => m);
}
