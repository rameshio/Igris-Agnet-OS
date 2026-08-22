/**
 * Model capability metadata (IGRIS CLI · unified model control plane).
 *
 * A controlled, HONEST description of what a provider's models can do — used so the
 * system can avoid selecting a model that cannot perform a task's needs (e.g. a
 * tool-backed `research.web` task on a text-only model → `MODEL_CAPABILITY_MISMATCH`).
 *
 * This is metadata, NOT a runtime claim: it never fabricates a capability. Cloud
 * providers in the catalog speak the OpenAI-compatible `/chat/completions` shape with
 * function/tool calling and structured output, so they carry `tool_calling`; local /
 * custom endpoints vary by the model loaded, so they are conservatively text-only until
 * an operator states otherwise. `vision` is claimed ONLY for a small, known allow-list.
 *
 * PURE (no DB, no network) — unit-testable in isolation.
 */
import { providerById } from '@/lib/models/catalog';
import { ModelRouteError } from '@/lib/models/types';

export type ModelCapability = 'text' | 'tool_calling' | 'structured_output' | 'vision';

/** Cloud providers whose OpenAI-compatible endpoint supports tools + structured output. */
const TOOL_CAPABLE_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'xai',
  'deepseek',
  'groq',
  'mistral',
  'openrouter',
  'together',
  'google',
  'nvidia',
]);

/** Providers whose flagship models are known-multimodal (kept small + honest). */
const VISION_PROVIDERS = new Set(['openai', 'anthropic', 'google']);

/** The Hermes brain runs tools internally; treated as tool-capable at the runtime level. */
export function hermesCapabilities(): ModelCapability[] {
  return ['text', 'tool_calling', 'structured_output'];
}

/** Capabilities a provider's models carry, by controlled metadata (never fabricated). */
export function providerCapabilities(providerId: string): ModelCapability[] {
  const p = providerById(providerId);
  if (!p) return [];
  const caps: ModelCapability[] = ['text'];
  if (TOOL_CAPABLE_PROVIDERS.has(p.id)) caps.push('tool_calling', 'structured_output');
  if (VISION_PROVIDERS.has(p.id)) caps.push('vision');
  return caps;
}

/** Does a provider (optionally a specific model) support a capability? */
export function supportsCapability(cap: ModelCapability, providerId: string, _modelId?: string): boolean {
  return providerCapabilities(providerId).includes(cap);
}

/** True when the provider/model can perform the app's tool-calling flow. */
export function modelSupportsTools(providerId: string, modelId?: string): boolean {
  return supportsCapability('tool_calling', providerId, modelId);
}

/**
 * Guard used before dispatching a task that REQUIRES tool calling to a fixed provider:
 * throws `MODEL_CAPABILITY_MISMATCH` when the chosen model cannot do tools, so the agent
 * never gets a task it will silently fail. No-op for capable models. (The gateway/Hermes
 * brains run tools; this guards an explicitly-chosen fixed provider/model.)
 */
export function assertModelCapability(cap: ModelCapability, providerId: string, modelId?: string): void {
  if (!supportsCapability(cap, providerId, modelId)) {
    const p = providerById(providerId);
    throw new ModelRouteError(
      'model_capability_mismatch',
      `${p?.name ?? providerId}${modelId ? ` · ${modelId}` : ''} does not support ${cap} — choose a ${cap}-capable model.`,
    );
  }
}
