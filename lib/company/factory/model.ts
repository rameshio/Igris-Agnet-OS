/**
 * Agent Factory — pure model (Architecture V2 · F2).
 *
 * F1 surfaces a CAPABILITY_GAP whenever no existing agent (and no published
 * workflow) can satisfy a task's requiredCapabilities — and F1 deliberately STOPS
 * there ("F1 never creates an agent — that is F2"). F2 closes that loop with
 * CONTROLLED, HUMAN-GATED dynamic agent creation: an LLM proposes an agent spec, the
 * SERVER validates it against a FactoryPolicy, and the agent is CREATED only when a
 * human APPROVES the proposal (promotion). Nothing here is autonomous.
 *
 * This module is PURE (zod + the F0.1 capability id rules only — no DB, no LLM) so
 * the policy, the proposal spec schema, the policy validator, and the safe event
 * projection are fully unit-testable without SQLite or a live model.
 *
 * Safety invariants the SERVER owns (never the LLM):
 *   - a proposed agent may carry ONLY tools on the policy allow-list, bounded in count
 *   - its model must be on the allow-list (or the '' system default)
 *   - instructions are length-bounded; capability ids pass F0.1 validation
 *   - creation depth is bounded (maxDepth) and factory agents cannot spawn (canSpawn=false)
 * A spec that violates policy FAILS SAFE — nothing is created (mirrors a bad plan).
 */
import { z } from 'zod';
import { isValidCapabilityId, normalizeCapabilityId } from '@/lib/agents/capabilities';
import { toolRequirementFor, satisfiesToolRequirement } from '@/lib/agents/capability-tools';

// ── Hard ceilings — a bounded override may only make a policy STRICTER, never
//    exceed these. They are the outer safety envelope, independent of any override.
export const FACTORY_MAX_TOOLS_CEILING = 8;
export const FACTORY_MAX_INSTRUCTIONS_CEILING = 8000; // matches CustomAgentInputSchema
export const FACTORY_MAX_DEPTH_CEILING = 3;

/**
 * The real, callable integration slugs a factory agent may be granted. Kept in sync
 * with the live REGISTRY in lib/agents/agent-tools.ts — only slugs with a real
 * connector-backed capability are grantable (anything else would be inert or unsafe).
 */
export const FACTORY_ALLOWED_TOOLS = ['slack', 'gmail', 'notion', 'telegram', 'stripe', 'attio', 'gbrain'] as const;

/** Gateway models a factory agent may run on. '' = the system default (always allowed). */
export const FACTORY_ALLOWED_MODELS = [
  '',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-5',
  'anthropic/claude-haiku-4-5',
] as const;

export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

// ── Factory policy ────────────────────────────────────────────────────────────
export type FactoryPolicy = {
  allowedTools: string[];
  allowedModels: string[];
  maxTools: number;
  maxInstructions: number;
  maxDepth: number;
  canSpawn: boolean;
  defaultDepartmentId: string;
  budgetUsd: number | null;
};

/** The conservative default. Factory agents are temporary, single-depth, non-spawning. */
export const DEFAULT_FACTORY_POLICY: FactoryPolicy = {
  allowedTools: [...FACTORY_ALLOWED_TOOLS],
  allowedModels: [...FACTORY_ALLOWED_MODELS],
  maxTools: 5,
  maxInstructions: FACTORY_MAX_INSTRUCTIONS_CEILING,
  maxDepth: 1,
  canSpawn: false,
  defaultDepartmentId: 'dept-tech',
  budgetUsd: 5,
};

/**
 * A bounded override at the API boundary. Every field is capped at its ceiling, and
 * `allowedTools` can only be a SUBSET of the grantable slugs (the enum enforces it) —
 * an override can therefore only make the policy stricter, never widen it.
 */
export const FactoryPolicyOverrideSchema = z
  .object({
    maxTools: z.number().int().min(0).max(FACTORY_MAX_TOOLS_CEILING),
    maxInstructions: z.number().int().min(1).max(FACTORY_MAX_INSTRUCTIONS_CEILING),
    maxDepth: z.number().int().min(1).max(FACTORY_MAX_DEPTH_CEILING),
    budgetUsd: z.number().min(0).nullable(),
    allowedTools: z.array(z.enum(FACTORY_ALLOWED_TOOLS)),
    defaultDepartmentId: z.string().trim().min(1).max(60),
  })
  .partial();
export type FactoryPolicyOverride = z.infer<typeof FactoryPolicyOverrideSchema>;

/** Merge a validated (bounded) override onto the default policy. Validates unknown input. */
export function resolvePolicy(override?: unknown): FactoryPolicy {
  if (override === undefined || override === null) return { ...DEFAULT_FACTORY_POLICY };
  const parsed = FactoryPolicyOverrideSchema.parse(override);
  return { ...DEFAULT_FACTORY_POLICY, ...parsed };
}

// ── Proposed agent spec (LLM-produced, schema-constrained) ────────────────────
const CapabilityRefSchema = z
  .string()
  .transform(normalizeCapabilityId)
  .refine(isValidCapabilityId, 'invalid capability id — use lowercase `domain.action`');

export const AgentSpecSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
  instructions: z.string().trim().min(1).max(FACTORY_MAX_INSTRUCTIONS_CEILING),
  model: z.string().max(120).default(''),
  tools: z.array(z.string().trim().min(1).max(60)).max(FACTORY_MAX_TOOLS_CEILING).default([]),
  requiredCapabilities: z.array(CapabilityRefSchema).min(1).max(20),
  rationale: z.string().max(1000).optional(),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

// ── Proposal (the pending, human-gated artifact — no agent exists until approved) ─
export type AgentProposal = {
  id: string;
  missionId: string;
  taskId?: string;
  status: ProposalStatus;
  spec: AgentSpec;
  policy: FactoryPolicy;
  requiredCapabilities: string[]; // SERVER-owned: exactly the gap this fills
  rationale?: string;
  temporary: boolean;
  maxDepth: number;
  budgetUsd: number | null;
  agentId?: string; // set on promotion (the created custom agent)
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
  updatedAt: string;
};

// ── Policy validation (pure; fail-safe) ───────────────────────────────────────
export type PolicyCheck = { ok: boolean; violations: string[] };

/**
 * Validate a proposed spec against a policy at a given creation depth. Returns every
 * violation (empty ⇒ ok). The caller rejects a non-ok spec and creates NOTHING —
 * exactly like an invalid mission plan fails safely.
 */
export function validateSpecAgainstPolicy(spec: AgentSpec, policy: FactoryPolicy, depth: number): PolicyCheck {
  const violations: string[] = [];
  if (spec.instructions.length > policy.maxInstructions) {
    violations.push(`instructions exceed ${policy.maxInstructions} chars`);
  }
  if (spec.tools.length > policy.maxTools) {
    violations.push(`too many tools (${spec.tools.length} > ${policy.maxTools})`);
  }
  const badTools = spec.tools.filter((t) => !policy.allowedTools.includes(t));
  if (badTools.length) violations.push(`tools not on allow-list: ${badTools.join(', ')}`);
  if (!policy.allowedModels.includes(spec.model)) {
    violations.push(`model not allowed: ${spec.model || '(default)'}`);
  }
  if (depth > policy.maxDepth) violations.push(`creation depth ${depth} exceeds maxDepth ${policy.maxDepth}`);
  if (spec.requiredCapabilities.length === 0) violations.push('at least one required capability is needed');
  // Tool-backed capability check: a granted capability that REQUIRES a concrete tool must
  // be satisfied by tools the factory can actually grant (on the policy allow-list). This
  // stops the factory from ever creating an agent that carries a capability LABEL it cannot
  // truly perform (e.g. `research.web` with no grantable web tool → fail safe, no agent).
  const grantable = new Set(policy.allowedTools);
  for (const capId of spec.requiredCapabilities) {
    const req = toolRequirementFor(capId);
    if (req && !satisfiesToolRequirement(req, spec.tools, grantable)) {
      violations.push(`capability ${capId} requires a tool the factory cannot grant (needs ${req.mode} of [${req.requiredToolIds.join(', ')}]; none are grantable)`);
    }
  }
  return { ok: violations.length === 0, violations };
}

// ── Safe projection — identifiers + labels for the event ledger / feeds ───────
export type SafeProposalSummary = {
  id: string;
  missionId: string;
  taskId?: string;
  status: ProposalStatus;
  agentName: string;
  requiredCapabilities: string[];
  tools: string[];
  model: string;
  rationale?: string;
  temporary: boolean;
  agentId?: string;
  createdAt: string;
};

/** Safe view for the append-only ledger and feeds — NO instructions, NO policy internals. */
export function safeProposalSummary(p: AgentProposal): SafeProposalSummary {
  return {
    id: p.id,
    missionId: p.missionId,
    taskId: p.taskId,
    status: p.status,
    agentName: p.spec.name,
    requiredCapabilities: p.requiredCapabilities,
    tools: p.spec.tools,
    model: p.spec.model || '(default)',
    rationale: p.rationale,
    temporary: p.temporary,
    agentId: p.agentId,
    createdAt: p.createdAt,
  };
}
