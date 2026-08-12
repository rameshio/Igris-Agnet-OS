/**
 * Agent executor (Phase C) — the core executor.
 *
 * Resolves the referenced runtime agent (built-in or custom), routes through the
 * Phase-B ModelRouter using the AGENT's own model strategy, and returns the
 * output plus model metadata for the node run. It deliberately does NOT use
 * chatWithAgent (which persists interactive chat history) — workflow node
 * execution is recorded in flow_node_runs, separate from chat.
 */
import { validateNodeConfig, type NodeExecutor } from '@/lib/flows/registry';
import { NodeExecError } from '@/lib/flows/errors';
import { routeModel } from '@/lib/models/router';
import { parseModelSettings } from '@/lib/models/settings';
import { systemPromptFor } from '@/lib/agents/chat';
import { stableStringify } from '@/lib/flows/references';
import type { NodeOutput } from '@/lib/flows/run-types';

/**
 * Deterministically render an agent's resolved input as prompt text (spec §32):
 * plain text passes through; structured `data` is serialized as pretty JSON —
 * never `[object Object]`.
 */
function inputToPrompt(input: NodeOutput): string {
  if (input.text?.trim()) return input.text;
  if (input.data !== undefined && input.data !== null) return `Workflow input:\n${stableStringify(input.data)}`;
  return '';
}

export const agentExecutor: NodeExecutor = {
  type: 'agent',
  executable: true,
  validateConfig: (c) => validateNodeConfig('agent', c),
  async execute(ctx) {
    const cfg = ctx.node.config as { agentId?: string };
    const agent = ctx.agents.find((a) => a.id === cfg.agentId);
    if (!agent) throw new NodeExecError('agent_not_found', `Agent "${cfg.agentId ?? ''}" was not found.`);

    // The AGENT owns its model strategy (Phase B). Node-level override is Phase D.
    const settings = parseModelSettings(agent.model);
    const userText =
      inputToPrompt(ctx.input) ||
      ctx.startingInput.text?.trim() ||
      'Run your task using any provided context, and report your result concisely.';

    const result = await routeModel(ctx.db, settings, {
      system: systemPromptFor(agent),
      messages: [{ role: 'user', content: userText }],
      tools: agent.chatTools?.(),
    });

    const inTok = result.usage?.inputTokens;
    const outTok = result.usage?.outputTokens;
    return {
      output: { text: result.text },
      meta: {
        strategy: result.strategy,
        adapter: result.adapter,
        providerId: result.providerId,
        modelId: result.modelId,
        promptTokens: inTok,
        completionTokens: outTok,
        totalTokens: inTok != null && outTok != null ? inTok + outTok : undefined,
        estimatedCost: null, // Phase C: no fabricated pricing
        fallbackUsed: result.fallbackUsed,
      },
    };
  },
};
