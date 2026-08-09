/**
 * Data-driven custom agents.
 *
 * The built-in roster (lib/agents/real.ts) is code: each agent has a hand-written
 * run() bound to a specific connector. Custom agents are the opposite — pure DATA
 * in the `custom_agents` table that an operator creates and edits from the UI.
 * This module is the bridge: it turns a stored CustomAgent row into a live
 * RuntimeAgent whose run()/respond() drive the LLM with the operator's own
 * instructions, and it owns the validated create/update path used by the API.
 */
import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import { getLlmProvider, type LlmProvider, type LlmToolSpec } from '@/lib/connectors/llm';
import { CustomAgentInputSchema, type CustomAgent } from '@/lib/schemas';
import { agentToolSpecsFor } from '@/lib/agents/agent-tools';
import type { AgentRunResult, RuntimeAgent } from '@/lib/agents/runtime';

// What a bare "run" asks a custom agent to do when no message is supplied
// (the Run button on /agents). Kept read-only and honest, matching the built-ins.
const DEFAULT_RUN_PROMPT =
  'Run your task now. Report a concise status update on what you did or would do next. Be specific and honest about anything you cannot yet access.';

/** Build a live RuntimeAgent from a stored custom-agent config. */
export function buildCustomRuntimeAgent(
  cfg: CustomAgent,
  provider: LlmProvider = getLlmProvider(),
): RuntimeAgent {
  // The agent's connected tools, wired to real connectors. The model may call
  // these mid-run to read live data or take an action.
  const tools = (): LlmToolSpec[] => agentToolSpecsFor(cfg.tools);

  async function ask(userMessage: string): Promise<AgentRunResult> {
    if (!cfg.enabled) {
      return { ok: false, summary: `${cfg.name} is disabled — enable it to run.` };
    }
    const specs = tools();
    const res = await provider.chat({
      system: cfg.instructions,
      messages: [{ role: 'user', content: userMessage }],
      model: cfg.model || undefined,
      tools: specs.length ? specs : undefined,
    });
    return {
      ok: true,
      summary: res.text,
      data: { toolCalls: res.toolCalls },
      model: cfg.model || undefined,
      tokensIn: res.usage?.inputTokens,
      tokensOut: res.usage?.outputTokens,
    };
  }

  return {
    id: cfg.id,
    name: cfg.name,
    description: cfg.description,
    departmentId: cfg.departmentId,
    systemPrompt: cfg.instructions,
    model: cfg.model || undefined,
    run: () => ask(DEFAULT_RUN_PROMPT),
    respond: (message: string) => ask(message),
    chatTools: tools,
  };
}

/** Every stored custom agent, as live RuntimeAgents. */
export function customRuntimeAgents(db: FounderDb, provider?: LlmProvider): RuntimeAgent[] {
  return db.customAgents.all().map((a) => buildCustomRuntimeAgent(a, provider));
}

/** Validate a create payload, assign identity + timestamps, persist, return it. */
export function createCustomAgent(db: FounderDb, input: unknown): CustomAgent {
  const parsed = CustomAgentInputSchema.parse(input);
  const now = new Date().toISOString();
  const agent: CustomAgent = { id: `custom-${randomUUID()}`, ...parsed, createdAt: now, updatedAt: now };
  db.customAgents.insert(agent);
  return agent;
}

/** Apply a partial update to an existing custom agent. Throws if it is unknown. */
export function updateCustomAgent(db: FounderDb, id: string, input: unknown): CustomAgent {
  const existing = db.customAgents.get(id);
  if (!existing) throw new Error(`unknown custom agent: ${id}`);
  const parsed = CustomAgentInputSchema.partial().parse(input);
  const updated: CustomAgent = { ...existing, ...parsed, updatedAt: new Date().toISOString() };
  db.customAgents.insert(updated);
  return updated;
}
