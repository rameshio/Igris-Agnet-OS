/**
 * Capability → Tool requirements (Architecture V2 · tool-backed eligibility).
 *
 * A CAPABILITY is what an agent is qualified/intended to do (`domain.action`).
 * A TOOL is the concrete, connector-backed mechanism it uses. **They are not the
 * same** — a `research.web` label does NOT mean the agent can actually reach the
 * live web. Some capabilities are model-only (analysis, summarization, writing,
 * `research.market` over supplied material); others REQUIRE a real tool to be
 * genuinely performable.
 *
 * This is a small, GENERIC, controlled registry (no schema change): only the
 * capabilities that genuinely need a tool are listed; everything else is model-only
 * and behaves exactly as before. Eligibility for a tool-backed capability requires
 * BOTH the capability AND that a required tool is actually assigned to the agent AND
 * available/wired in the runtime — never inferred from instructions/descriptions.
 *
 * PURE (only the F0.1 id normalizer): unit-testable without SQLite or connectors.
 */
import { normalizeCapabilityId } from '@/lib/agents/capabilities';

export type ToolRequirementMode = 'any' | 'all';
export type CapabilityToolRequirement = { capabilityId: string; requiredToolIds: string[]; mode: ToolRequirementMode };

/**
 * The registry. Keys are canonical capability ids; only TOOL-BACKED capabilities appear.
 *
 * `research.web` requires the real `web.search` tool — a genuine live web/search connector
 * (Tavily, see `lib/connectors/websearch.ts`), wired into the agent tool REGISTRY and on the
 * Factory allow-list. An agent is eligible for `research.web` only when it actually carries
 * `web.search`; a label alone, Slack, or shared notes never satisfy it. When no agent has the
 * tool (or the provider key is unset), `research.web` remains an explicit, honest TOOL GAP.
 */
const CAPABILITY_TOOL_REQUIREMENTS: Record<string, CapabilityToolRequirement> = {
  'research.web': { capabilityId: 'research.web', requiredToolIds: ['web.search'], mode: 'any' },
};

/** The tool requirement for a capability, or null when the capability is model-only. */
export function toolRequirementFor(capabilityId: string): CapabilityToolRequirement | null {
  return CAPABILITY_TOOL_REQUIREMENTS[normalizeCapabilityId(capabilityId)] ?? null;
}

/** True if the capability has any tool requirement at all. */
export function isToolBackedCapability(capabilityId: string): boolean {
  return toolRequirementFor(capabilityId) !== null;
}

/**
 * Which of a requirement's tools are genuinely USABLE by an agent: assigned to the
 * agent AND present in the available/wired set. Availability is canonical (wired
 * connector), never inferred from prose.
 */
export function usableRequiredTools(req: CapabilityToolRequirement, agentTools: readonly string[], availableTools: ReadonlySet<string>): string[] {
  const assigned = new Set(agentTools);
  return req.requiredToolIds.filter((t) => assigned.has(t) && availableTools.has(t));
}

/** Does the agent satisfy the requirement (`any` = ≥1 usable tool, `all` = every required tool usable)? */
export function satisfiesToolRequirement(req: CapabilityToolRequirement, agentTools: readonly string[], availableTools: ReadonlySet<string>): boolean {
  const usable = usableRequiredTools(req, agentTools, availableTools);
  return req.mode === 'all' ? usable.length === req.requiredToolIds.length : usable.length > 0;
}

/** An explicit, SAFE (no secrets) reason string for a capability's tool gap. */
export function toolGapReason(req: CapabilityToolRequirement): string {
  const list = req.requiredToolIds.join(req.mode === 'all' ? ' + ' : ' or ');
  return `${req.capabilityId} requires a ${list} tool, but no eligible tool is available`;
}
