import { afterEach, describe, expect, test, vi } from 'vitest';
import path from 'node:path';
import { openDb } from '@/lib/db';
import { getHermesClient } from '@/lib/connectors/hermes-client';
import { shutdownHermesAcp } from '@/lib/connectors/hermes-acp';
import { routeModel } from '@/lib/models/router';

// Reuse the ACP fake agent (built for INC-005) so we can exercise the seam over a
// real 'acp' transport without a Hermes install.
const FAKE_ACP = path.join(process.cwd(), 'tests', 'fixtures', 'fake-hermes-acp.mjs');
const req = { messages: [{ role: 'user' as const, content: 'hello' }] };
const withFakeAcp = (timeout = '8000') => {
  vi.stubEnv('LLM_PROVIDER', 'hermes-acp');
  vi.stubEnv('HERMES_ACP_BIN', process.execPath);
  vi.stubEnv('HERMES_ACP_ARGS', FAKE_ACP);
  vi.stubEnv('HERMES_ACP_TIMEOUT_MS', timeout);
};

afterEach(async () => {
  shutdownHermesAcp();
  // Let the killed process's async 'close' land now (module singletons are shared
  // across tests) so a stale teardown can't contaminate the next test's process.
  await new Promise((r) => setTimeout(r, 120));
  vi.unstubAllEnvs();
});

describe('HermesClient seam (H1)', () => {
  test('stub brain: normalized result carries transport + brainName', async () => {
    vi.stubEnv('LLM_PROVIDER', 'stub');
    const c = getHermesClient();
    expect(c.transport).toBe('stub');
    const r = await c.chat(req);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.brainName).toBe('stub');
    expect(r.transport).toBe('stub');
  });

  test('capabilities never upgrade unverified (MCP/skills) to true', () => {
    vi.stubEnv('LLM_PROVIDER', 'stub');
    withFakeAcp();
    const caps = getHermesClient().capabilities();
    expect(caps.chat).toBe(true);
    expect(caps.mcp).toBe('unknown');
    expect(caps.skills).toBe('unknown');
  });

  test('ACP transport: chat works; health honest; caps tri-state', async () => {
    withFakeAcp();
    const c = getHermesClient();
    expect(c.transport).toBe('acp');
    const r = await c.chat(req);
    expect(r.text).toContain('ok:');
    expect(r.brainName).toBe('hermes-acp');
    expect(r.transport).toBe('acp');

    const h = await c.health();
    expect(h.transport).toBe('acp');
    expect(h.independentProbe).toBe(false); // ACP has NO independent probe — never faked
    expect(h.status).toBe('unknown');

    const caps = c.capabilities();
    expect(caps.cancellation).toBe(true); // internal cancel on timeout (INC-005)
    expect(caps.multiSession).toBe(false); // serialized queue
    expect(caps.mcp).toBe('unknown');
    expect(caps.skills).toBe('unknown');
  }, 20_000);

  test('ACP timeout/cancel/recovery preserved THROUGH the seam (INC-005)', async () => {
    withFakeAcp('3000'); // headroom for node cold-start; HANG still times out quickly enough
    const c = getHermesClient();
    await expect(c.chat({ messages: [{ role: 'user', content: 'hello' }] })).resolves.toBeTruthy(); // warm
    await expect(c.chat({ messages: [{ role: 'user', content: 'please HANG' }] })).rejects.toThrow(/timed out/i);
    await expect(c.chat({ messages: [{ role: 'user', content: 'again' }] })).resolves.toBeTruthy(); // recovered
  }, 20_000);
});

describe('ModelRouter integration (output unchanged through the seam)', () => {
  test('hermes strategy → adapter brain:stub; no seam fields leak into ModelRouteResult', async () => {
    vi.stubEnv('LLM_PROVIDER', 'stub');
    const db = openDb(':memory:');
    const res = await routeModel(db, { strategy: 'hermes', config: {} }, req);
    expect(res.strategy).toBe('hermes');
    expect(res.adapter).toBe('brain:stub');
    expect(res.fallbackUsed).toBe(false);
    expect((res as Record<string, unknown>).transport).toBeUndefined();
    expect((res as Record<string, unknown>).brainName).toBeUndefined();
  });

  test('hermes strategy → adapter brain:hermes-acp when the ACP brain serves', async () => {
    withFakeAcp();
    const db = openDb(':memory:');
    const res = await routeModel(db, { strategy: 'hermes', config: {} }, req);
    expect(res.adapter).toBe('brain:hermes-acp');
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.fallbackUsed).toBe(false);
  }, 20_000);
});
