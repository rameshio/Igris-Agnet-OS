/**
 * Global default model — the canonical, server-side config for "what model does the
 * app use when nothing more specific is chosen" (IGRIS CLI · model control plane).
 *
 * Persisted in the existing `meta` key-value store (NOT a random file, NOT the browser)
 * so the CLI and UI share one authority. The value uses the SAME encoding as an agent's
 * `model` string: '' / 'hermes' (the brain), 'auto', or 'providerId:modelId'.
 *
 * Selection hierarchy (documented + reused, never re-implemented per feature):
 *   explicit run override  →  agent model  →  global default (this)  →  brain ('')
 * This module owns the default + the hierarchy resolver; it does NOT rewrite persisted
 * agent assignments and it never reads or returns a credential.
 */
import type { FounderDb } from '@/lib/db';
import { providerById } from '@/lib/models/catalog';
import { parseModelSettings } from '@/lib/models/settings';

export const DEFAULT_MODEL_META_KEY = 'default_model';

/** Validate a model string in the shared encoding. Empty/'hermes'/'auto' are always valid. */
export function isValidModelString(model: string): boolean {
  const raw = model.trim();
  if (raw === '' || raw === 'hermes' || raw === 'auto') return true;
  const colon = raw.indexOf(':');
  if (colon > 0) return Boolean(providerById(raw.slice(0, colon)) && raw.slice(colon + 1).trim());
  // A gateway-style 'provider/model' passthrough is accepted (routed via the brain).
  return raw.length <= 120;
}

/** The configured global default model string ('' = the active brain). */
export function getDefaultModel(db: FounderDb): string {
  return db.meta.get(DEFAULT_MODEL_META_KEY) ?? '';
}

/** Persist the global default model (validated). Returns the stored value. */
export function setDefaultModel(db: FounderDb, model: string): string {
  const raw = model.trim();
  if (!isValidModelString(raw)) {
    throw new Error(`invalid model "${model}" — use '', 'hermes', 'auto', or 'providerId:modelId'`);
  }
  db.meta.set(DEFAULT_MODEL_META_KEY, raw);
  return raw;
}

/**
 * Resolve the effective model string for a call, applying the documented hierarchy.
 * `override` is an explicit per-run choice; `agentModel` is the agent's stored model.
 * The result is a model STRING (parse with `parseModelSettings` at the call site).
 */
export function resolveEffectiveModel(
  db: FounderDb,
  opts: { override?: string | null; agentModel?: string | null } = {},
): string {
  const override = (opts.override ?? '').trim();
  if (override) return override;
  const agentModel = (opts.agentModel ?? '').trim();
  if (agentModel) return agentModel;
  return getDefaultModel(db);
}

/** A readable, secret-free description of the effective default (for status/CLI). */
export function describeDefaultModel(db: FounderDb): { model: string; settings: ReturnType<typeof parseModelSettings> } {
  const model = getDefaultModel(db);
  return { model, settings: parseModelSettings(model) };
}
