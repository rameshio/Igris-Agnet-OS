import { describe, expect, test } from 'vitest';
import { parseModelSettings, serializeModelSettings, describeModel } from '@/lib/models/settings';

describe('model settings parse/serialize (backward compatible)', () => {
  test('empty string → hermes (the default brain)', () => {
    expect(parseModelSettings('')).toEqual({ strategy: 'hermes', config: {} });
    expect(parseModelSettings(undefined)).toEqual({ strategy: 'hermes', config: {} });
  });

  test('"auto" → auto', () => {
    expect(parseModelSettings('auto')).toEqual({ strategy: 'auto', config: {} });
  });

  test('providerId:modelId (known provider) → fixed', () => {
    expect(parseModelSettings('openai:gpt-4o')).toEqual({ strategy: 'fixed', config: { providerId: 'openai', modelId: 'gpt-4o' } });
    expect(parseModelSettings('nvidia:meta/llama-3.3-70b-instruct')).toEqual({
      strategy: 'fixed',
      config: { providerId: 'nvidia', modelId: 'meta/llama-3.3-70b-instruct' },
    });
  });

  test('unknown/gateway-style string → hermes passthrough (never lost)', () => {
    expect(parseModelSettings('anthropic/claude-sonnet-5')).toEqual({ strategy: 'hermes', config: { modelId: 'anthropic/claude-sonnet-5' } });
  });

  test('round-trips through serialize', () => {
    for (const raw of ['', 'auto', 'openai:gpt-4o', 'anthropic/claude-sonnet-5']) {
      expect(serializeModelSettings(parseModelSettings(raw))).toBe(raw);
    }
  });

  test('incomplete fixed serializes to the safe default', () => {
    expect(serializeModelSettings({ strategy: 'fixed', config: { providerId: 'openai' } })).toBe('');
  });

  test('describeModel produces human badges', () => {
    expect(describeModel({ strategy: 'hermes', config: {} })).toBe('Hermes');
    expect(describeModel({ strategy: 'auto', config: {} })).toBe('Auto');
    expect(describeModel({ strategy: 'fixed', config: { providerId: 'nvidia', modelId: 'nemotron' } }, { providerName: 'NVIDIA' })).toBe('NVIDIA · nemotron');
    expect(describeModel({ strategy: 'fixed', config: { providerId: 'nvidia', modelId: 'nemotron' } }, { providerName: 'NVIDIA', available: false })).toBe('NVIDIA · nemotron · unavailable');
  });
});
