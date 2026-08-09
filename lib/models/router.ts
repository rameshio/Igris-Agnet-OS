/**
 * ModelRouter (Phase B) — the one app-wide entry that resolves an agent's model
 * strategy to a concrete adapter and executes a chat, returning execution
 * metadata Phase C can persist. Reusable by custom agents, built-ins, the
 * Conductor, and (later) the workflow engine. No React, no scattered per-provider
 * routing, no silent fallback.
 *
 *   settings → strategy → { fixed → provider adapter | hermes → brain | auto → stub }
 */
import type { FounderDb } from '@/lib/db';
import type { LlmChatRequest } from '@/lib/connectors/llm';
import { getLlmProvider } from '@/lib/connectors/llm';
import { createOpenAiCompatibleProvider } from '@/lib/connectors/openai-compatible';
import { providerRequiresKey } from '@/lib/models/catalog';
import { resolveConnection } from '@/lib/models/connections';
import { ModelRouteError, type AgentModelSettings, type ModelRouteResult } from '@/lib/models/types';

/** Map a thrown adapter/HTTP error to a distinct, honest ModelErrorCode. */
function normalizeAdapterError(err: unknown, providerName: string): ModelRouteError {
  const msg = err instanceof Error ? err.message : String(err);
  const status = /\b(\d{3})\b/.exec(msg)?.[1];
  if (status === '401' || status === '403') return new ModelRouteError('auth_failed', `${providerName}: authentication failed.`);
  if (status === '429') return new ModelRouteError('rate_limited', `${providerName}: rate limited.`);
  if (status === '404') return new ModelRouteError('model_unavailable', `${providerName}: model or endpoint not found.`);
  if (/could not reach|network|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(msg))
    return new ModelRouteError('network_error', `${providerName}: could not reach the endpoint.`);
  return new ModelRouteError('provider_unavailable', `${providerName}: ${msg.slice(0, 160)}`);
}

export async function routeModel(
  db: FounderDb,
  settings: AgentModelSettings,
  req: LlmChatRequest,
): Promise<ModelRouteResult> {
  if (settings.strategy === 'auto') {
    throw new ModelRouteError('auto_not_implemented', 'Auto routing is not implemented yet — choose Fixed or Hermes.');
  }

  if (settings.strategy === 'hermes') {
    const brain = getLlmProvider(); // the active brain (Hermes ACP by default)
    try {
      const res = await brain.chat({ ...req, model: settings.config.modelId });
      return { ...res, strategy: 'hermes', adapter: `brain:${brain.name}`, modelId: settings.config.modelId, fallbackUsed: false };
    } catch (err) {
      throw new ModelRouteError('hermes_unavailable', err instanceof Error ? err.message.slice(0, 200) : 'Hermes unavailable.');
    }
  }

  // strategy === 'fixed'
  const { providerId, modelId } = settings.config;
  if (!providerId) throw new ModelRouteError('provider_not_configured', 'No provider selected for this agent.');
  const conn = resolveConnection(db, providerId);
  if (!conn) throw new ModelRouteError('provider_not_configured', `Unknown provider "${providerId}".`);
  if (!conn.enabled) throw new ModelRouteError('provider_disabled', `Provider "${conn.provider.name}" is disabled.`);
  if (providerRequiresKey(conn.provider) && !conn.hasCredential)
    throw new ModelRouteError('credential_missing', `${conn.provider.name} has no API key configured.`);
  if (!conn.baseUrl) throw new ModelRouteError('invalid_base_url', `${conn.provider.name} has no base URL configured.`);
  if (!modelId) throw new ModelRouteError('model_unavailable', `No model selected for ${conn.provider.name}.`);

  const adapter = createOpenAiCompatibleProvider(conn.baseUrl, conn.apiKey ?? '', modelId);
  try {
    const res = await adapter.chat(req);
    return { ...res, strategy: 'fixed', adapter: 'openai-compatible', providerId, modelId, fallbackUsed: false };
  } catch (err) {
    throw normalizeAdapterError(err, conn.provider.name);
  }
}
