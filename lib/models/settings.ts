/**
 * Agent model settings ⇄ storage string (Phase B, backward compatible).
 *
 * The agent `model` column already exists and holds either '' (default brain),
 * a gateway/raw model, or `providerId:modelId`. We keep that column as the
 * source of truth and encode the strategy in it — no migration, old values keep
 * working:
 *   ''                      → hermes (the active brain; current default)
 *   'auto'                  → auto   (safe stub until the Auto Router lands)
 *   'providerId:modelId'    → fixed  (a connected direct provider)
 *   anything else (e.g.     → hermes with a raw model passthrough (e.g. a
 *     'anthropic/claude-…')    Vercel-gateway 'provider/model' string)
 */
import { providerById } from '@/lib/models/catalog';
import type { AgentModelSettings, ModelStrategy } from '@/lib/models/types';

/** Parse the stored `model` string into explicit strategy + config. */
export function parseModelSettings(model?: string | null): AgentModelSettings {
  const raw = (model ?? '').trim();
  if (raw === '' || raw === 'hermes') return { strategy: 'hermes', config: {} };
  if (raw === 'auto') return { strategy: 'auto', config: {} };

  const colon = raw.indexOf(':');
  if (colon > 0) {
    const providerId = raw.slice(0, colon);
    const modelId = raw.slice(colon + 1).trim();
    if (providerById(providerId) && modelId) {
      return { strategy: 'fixed', config: { providerId, modelId } };
    }
  }
  // Unknown/gateway-style string → let the brain handle it as a raw model.
  return { strategy: 'hermes', config: { modelId: raw } };
}

/** Serialize explicit settings back to the stored `model` string. */
export function serializeModelSettings(s: AgentModelSettings): string {
  if (s.strategy === 'auto') return 'auto';
  if (s.strategy === 'fixed') {
    const p = s.config.providerId?.trim();
    const m = s.config.modelId?.trim();
    if (!p || !m) return ''; // incomplete fixed → treat as default brain
    return `${p}:${m}`;
  }
  // hermes: keep any raw passthrough, else '' (default brain)
  return s.config.modelId?.trim() ?? '';
}

export type BadgeInfo = {
  /** human provider name for the badge, e.g. 'NVIDIA'. */
  providerName?: string;
  /** whether the referenced fixed provider is currently connected + enabled. */
  available?: boolean;
};

/**
 * A human-readable model badge label, resolved centrally so components never
 * parse storage strings themselves.
 *   fixed connected   → 'NVIDIA · nemotron-…'
 *   fixed unavailable → 'NVIDIA · nemotron-… · unavailable'
 *   hermes            → 'Hermes'
 *   auto              → 'Auto'
 */
export function describeModel(s: AgentModelSettings, info: BadgeInfo = {}): string {
  if (s.strategy === 'hermes') {
    return s.config.modelId ? `Hermes · ${s.config.modelId}` : 'Hermes';
  }
  if (s.strategy === 'auto') return 'Auto';
  // fixed
  const name = info.providerName ?? s.config.providerId ?? 'provider';
  const model = s.config.modelId ?? '—';
  const suffix = info.available === false ? ' · unavailable' : '';
  return `${name} · ${model}${suffix}`;
}

export const STRATEGY_LABELS: Record<ModelStrategy, string> = {
  fixed: 'Fixed model',
  hermes: 'Hermes',
  auto: 'Auto',
};
