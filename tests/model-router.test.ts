import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { openDb } from '@/lib/db';
import { routeModel } from '@/lib/models/router';
import { ModelRouteError } from '@/lib/models/types';

const prevLlm = process.env.LLM_PROVIDER;
beforeAll(() => {
  process.env.LLM_PROVIDER = 'stub';
});
afterAll(() => {
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NVIDIA_API_KEY;
});

const req = { messages: [{ role: 'user' as const, content: 'hi' }] };

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(ModelRouteError);
  await p.catch((e) => expect((e as ModelRouteError).code).toBe(code));
}

describe('ModelRouter', () => {
  test('auto → auto_not_implemented (safe stub, never silently picks a model)', async () => {
    const db = openDb(':memory:');
    await expectCode(routeModel(db, { strategy: 'auto', config: {} }, req), 'auto_not_implemented');
  });

  test('hermes → routes to the active brain', async () => {
    const db = openDb(':memory:');
    const res = await routeModel(db, { strategy: 'hermes', config: {} }, req);
    expect(res.strategy).toBe('hermes');
    expect(res.adapter).toBe('brain:stub');
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.fallbackUsed).toBe(false);
  });

  test('fixed with unknown provider → provider_not_configured', async () => {
    const db = openDb(':memory:');
    await expectCode(routeModel(db, { strategy: 'fixed', config: { providerId: 'nope', modelId: 'x' } }, req), 'provider_not_configured');
  });

  test('fixed with a disabled provider → provider_disabled', async () => {
    const db = openDb(':memory:');
    process.env.NVIDIA_API_KEY = 'test-key';
    db.modelConnections.upsert('nvidia', { enabled: false });
    await expectCode(routeModel(db, { strategy: 'fixed', config: { providerId: 'nvidia', modelId: 'x' } }, req), 'provider_disabled');
  });

  test('fixed with no credential → credential_missing', async () => {
    const db = openDb(':memory:');
    await expectCode(routeModel(db, { strategy: 'fixed', config: { providerId: 'nvidia', modelId: 'x' } }, req), 'credential_missing');
  });

  test('fixed with no model → model_unavailable', async () => {
    const db = openDb(':memory:');
    process.env.NVIDIA_API_KEY = 'test-key';
    await expectCode(routeModel(db, { strategy: 'fixed', config: { providerId: 'nvidia' } }, req), 'model_unavailable');
  });

  test('fixed happy path executes via the OpenAI-compatible adapter', async () => {
    const db = openDb(':memory:');
    process.env.NVIDIA_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'routed ✓' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      })),
    );
    const res = await routeModel(db, { strategy: 'fixed', config: { providerId: 'nvidia', modelId: 'nemotron' } }, req);
    expect(res.strategy).toBe('fixed');
    expect(res.adapter).toBe('openai-compatible');
    expect(res.providerId).toBe('nvidia');
    expect(res.modelId).toBe('nemotron');
    expect(res.text).toBe('routed ✓');
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });
});
