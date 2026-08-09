import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// In-memory .env.local so tests never touch the real gitignored secrets file.
const mem: Record<string, string> = {};
vi.mock('@/lib/creds', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    readEnvLocal: () => ({ ...mem }),
    upsertEnvLocal: (v: Record<string, string>) => Object.assign(mem, v),
    removeEnvLocal: (keys: string[]) => keys.forEach((k) => delete mem[k]),
    runtimeEnv: () => ({ ...process.env, ...mem }),
  };
});

const prevLlm = process.env.LLM_PROVIDER;
beforeAll(() => {
  process.env.FOUNDER_OS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'igris-models-')), 'test.db');
  process.env.LLM_PROVIDER = 'stub';
});
afterAll(() => {
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
});
afterEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  vi.restoreAllMocks();
});

async function load() {
  return import('@/app/api/models/route');
}
const json = (r: Response) => r.json();

describe('/api/models (Phase B) — security + status', () => {
  test('GET returns providers + a separate Hermes brain, and never a raw secret', async () => {
    mem.NVIDIA_API_KEY = 'supersecret-should-never-leak';
    const { GET } = await load();
    const body = await json((await GET()) as Response);
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.brain?.name).toBe('Hermes');
    const nvidia = body.providers.find((p: { id: string }) => p.id === 'nvidia');
    expect(nvidia.hasCredential).toBe(true); // presence only
    // the raw key must appear nowhere in the response
    expect(JSON.stringify(body)).not.toContain('supersecret-should-never-leak');
    for (const p of body.providers) {
      expect(p).not.toHaveProperty('apiKey');
      expect(p).not.toHaveProperty('key');
    }
  });

  test('connect stores the key backend-only; a later blank connect does NOT erase it', async () => {
    const { POST } = await load();
    await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ providerId: 'nvidia', action: 'connect', apiKey: 'k-123' }) }));
    expect(mem.NVIDIA_API_KEY).toBe('k-123');
    // blank apiKey, only a base-url-less re-save → key preserved
    await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ providerId: 'nvidia', action: 'connect' }) }));
    expect(mem.NVIDIA_API_KEY).toBe('k-123');
  });

  test('enable/disable toggles without touching the credential', async () => {
    const { GET, POST } = await load();
    mem.GROQ_API_KEY = 'g-1';
    await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ providerId: 'groq', action: 'disable' }) }));
    let body = await json((await GET()) as Response);
    expect(body.providers.find((p: { id: string }) => p.id === 'groq').enabled).toBe(false);
    await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ providerId: 'groq', action: 'enable' }) }));
    body = await json((await GET()) as Response);
    expect(body.providers.find((p: { id: string }) => p.id === 'groq').enabled).toBe(true);
    expect(mem.GROQ_API_KEY).toBe('g-1');
  });

  test('test action reflects a real backend check (mocked) and records status', async () => {
    mem.NVIDIA_API_KEY = 'k';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: 'nemotron' }, { id: 'llama' }] }) })));
    const { POST } = await load();
    const body = await json((await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ providerId: 'nvidia', action: 'test' }) }))) as Response);
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    expect(body.provider.status).toBe('connected');
  });

  test('DELETE removes the credential and connection row', async () => {
    mem.MISTRAL_API_KEY = 'm-1';
    const { GET, DELETE } = await load();
    await DELETE(new Request('http://x', { method: 'DELETE', body: JSON.stringify({ providerId: 'mistral' }) }));
    expect(mem.MISTRAL_API_KEY).toBeUndefined();
    const body = await json((await GET()) as Response);
    expect(body.providers.find((p: { id: string }) => p.id === 'mistral').hasCredential).toBe(false);
  });
});
