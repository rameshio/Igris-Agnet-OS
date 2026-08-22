/**
 * Unified model runtime — shared types (Phase B).
 *
 * A configurable agent carries a model STRATEGY (fixed direct provider · Hermes
 * brain · auto) plus a small CONFIG. The ModelRouter resolves this to a concrete
 * adapter at call time and returns execution metadata Phase C can persist.
 *
 * Storage note: to stay 100% backward compatible we keep encoding settings in
 * the existing agent `model` string (see settings.ts) — no destructive schema
 * change. These types are the explicit interface everything above storage uses.
 */
import type { LlmChatResult } from '@/lib/connectors/llm';

export type ModelStrategy = 'fixed' | 'hermes' | 'auto';

export interface ModelConfig {
  /** catalog provider id, e.g. 'openai' | 'nvidia' | 'ollama' (fixed strategy). */
  providerId?: string;
  /** provider model id, or a raw brain model passthrough (hermes strategy). */
  modelId?: string;
}

export interface AgentModelSettings {
  strategy: ModelStrategy;
  config: ModelConfig;
}

/** Distinct, honest failure reasons — never collapsed into "model failed". */
export type ModelErrorCode =
  | 'provider_not_configured'
  | 'provider_disabled'
  | 'credential_missing'
  | 'model_unavailable'
  | 'invalid_base_url'
  | 'provider_unavailable'
  | 'auth_failed'
  | 'rate_limited'
  | 'network_error'
  | 'hermes_unavailable'
  | 'unsupported_strategy'
  | 'model_capability_mismatch'
  | 'auto_not_implemented';

export class ModelRouteError extends Error {
  constructor(
    public readonly code: ModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelRouteError';
  }
}

/** What a route actually did — extends the transport result with metadata. */
export type ModelRouteResult = LlmChatResult & {
  strategy: ModelStrategy;
  /** adapter that served the call, e.g. 'openai-compatible' | 'brain:hermes-cli'. */
  adapter: string;
  providerId?: string;
  modelId?: string;
  /** Phase B never auto-switches models; reserved so Phase G can record it. */
  fallbackUsed: false;
};
