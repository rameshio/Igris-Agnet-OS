/**
 * Resolve an agent's `model` string (`providerId:modelId`) to a connected
 * provider + key, and report per-provider connection status for the board.
 * Keys are read fresh from .env.local so a connect takes effect without a
 * restart. Never echoes key values.
 */
import { MODEL_PROVIDERS, providerById, type ModelProvider } from '@/lib/models/catalog';
import { runtimeEnv } from '@/lib/creds';

export function keyFor(p: ModelProvider): string | undefined {
  const v = runtimeEnv()[p.envKey];
  return v && v.trim() ? v.trim() : undefined;
}

export function isConnected(p: ModelProvider): boolean {
  return Boolean(keyFor(p));
}

export type ResolvedModel = { provider: ModelProvider; modelId: string; apiKey: string };

/** `providerId:modelId` → resolved provider+key, or null if not applicable. */
export function resolveAgentModel(model?: string): ResolvedModel | null {
  if (!model) return null;
  const i = model.indexOf(':');
  if (i < 0) return null; // no provider scope (e.g. gateway "provider/model") → not ours
  const providerId = model.slice(0, i);
  const modelId = model.slice(i + 1).trim();
  const provider = providerById(providerId);
  if (!provider || !modelId) return null;
  const apiKey = keyFor(provider);
  if (!apiKey) return null; // provider not connected → caller falls back to the brain
  return { provider, modelId, apiKey };
}

/** True when a model string is provider-scoped (`providerId:...`) for a known provider. */
export function looksProviderScoped(model?: string): boolean {
  if (!model) return false;
  const i = model.indexOf(':');
  if (i < 0) return false;
  return Boolean(providerById(model.slice(0, i)));
}

/** Board view model: providers with connection state + curated model list. */
export function providerStatuses(): {
  id: string;
  name: string;
  envKey: string;
  baseUrl: string;
  docsUrl: string;
  connected: boolean;
  models: string[];
}[] {
  return MODEL_PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    envKey: p.envKey,
    baseUrl: p.baseUrl,
    docsUrl: p.docsUrl,
    connected: isConnected(p),
    models: p.models,
  }));
}
