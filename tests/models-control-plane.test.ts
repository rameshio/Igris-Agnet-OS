/**
 * Unified model control plane (IGRIS CLI) — capability metadata, the canonical global
 * default model (meta-backed), and the documented selection hierarchy. No live provider
 * calls; secrets never appear.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '@/lib/db';
import {
  providerCapabilities,
  modelSupportsTools,
  supportsCapability,
  assertModelCapability,
} from '@/lib/models/capabilities';
import {
  getDefaultModel,
  setDefaultModel,
  resolveEffectiveModel,
  isValidModelString,
} from '@/lib/models/default-model';
import { ModelRouteError } from '@/lib/models/types';

describe('model capabilities (honest metadata)', () => {
  it('cloud providers carry tool_calling; unknown ones do not', () => {
    expect(modelSupportsTools('openai')).toBe(true);
    expect(modelSupportsTools('anthropic')).toBe(true);
    expect(modelSupportsTools('google')).toBe(true);
    expect(providerCapabilities('openai')).toContain('structured_output');
    // local endpoints vary by loaded model → conservatively text-only
    expect(modelSupportsTools('ollama')).toBe(false);
    expect(providerCapabilities('ollama')).toEqual(['text']);
    // an unknown provider claims nothing
    expect(providerCapabilities('nope')).toEqual([]);
  });

  it('vision is claimed only for the known allow-list', () => {
    expect(supportsCapability('vision', 'openai')).toBe(true);
    expect(supportsCapability('vision', 'google')).toBe(true);
    expect(supportsCapability('vision', 'groq')).toBe(false);
  });

  it('assertModelCapability throws MODEL_CAPABILITY_MISMATCH for an incompatible model', () => {
    expect(() => assertModelCapability('tool_calling', 'openai')).not.toThrow();
    try {
      assertModelCapability('tool_calling', 'ollama', 'llama3');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ModelRouteError);
      expect((e as ModelRouteError).code).toBe('model_capability_mismatch');
    }
  });
});

describe('global default model (meta-backed)', () => {
  it('validates the model string encoding', () => {
    expect(isValidModelString('')).toBe(true);
    expect(isValidModelString('hermes')).toBe(true);
    expect(isValidModelString('auto')).toBe(true);
    expect(isValidModelString('openai:gpt-4o')).toBe(true);
    expect(isValidModelString('nope:model')).toBe(false); // unknown provider
    expect(isValidModelString('openai:')).toBe(false); // no model
  });

  it('persists + reads a validated default; rejects an invalid one', () => {
    const db = openDb(':memory:');
    expect(getDefaultModel(db)).toBe(''); // brain by default
    setDefaultModel(db, 'anthropic:claude-3-5-sonnet-latest');
    expect(getDefaultModel(db)).toBe('anthropic:claude-3-5-sonnet-latest');
    expect(() => setDefaultModel(db, 'bogus:')).toThrow();
  });

  it('resolves the hierarchy: override → agent → default → brain', () => {
    const db = openDb(':memory:');
    setDefaultModel(db, 'openai:gpt-4o');
    expect(resolveEffectiveModel(db, { override: 'google:gemini-2.5-pro', agentModel: 'anthropic:claude-opus-4' })).toBe('google:gemini-2.5-pro');
    expect(resolveEffectiveModel(db, { agentModel: 'anthropic:claude-opus-4' })).toBe('anthropic:claude-opus-4');
    expect(resolveEffectiveModel(db, {})).toBe('openai:gpt-4o'); // global default
    const fresh = openDb(':memory:');
    expect(resolveEffectiveModel(fresh, {})).toBe(''); // brain
  });
});
