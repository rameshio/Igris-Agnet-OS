import { afterEach, describe, expect, test, vi } from 'vitest';
import path from 'node:path';
import { hermesAcpPrompt, shutdownHermesAcp } from '@/lib/connectors/hermes-acp';

// Drive the connector against a fake ACP agent (node running the fixture) — no
// Hermes install, cross-platform. The fake models a single-turn-busy agent: a
// "HANG" prompt occupies it until a session/cancel arrives; later prompts stall
// behind it. So this exercises the real bug: does a timed-out prompt free the
// persistent process for the next request?
const FAKE = path.join(process.cwd(), 'tests', 'fixtures', 'fake-hermes-acp.mjs');

afterEach(() => {
  shutdownHermesAcp();
  vi.unstubAllEnvs();
});

describe('Hermes ACP timeout & recovery', () => {
  test('a timed-out prompt is cancelled and does NOT poison the persistent process', async () => {
    vi.stubEnv('HERMES_ACP_BIN', process.execPath); // node
    vi.stubEnv('HERMES_ACP_ARGS', FAKE); // → node <fake-hermes-acp.mjs>
    vi.stubEnv('HERMES_ACP_TIMEOUT_MS', '500');

    // 1) a normal request succeeds over the warm process
    await expect(hermesAcpPrompt('hello')).resolves.toBe('ok:hello');

    // 2) a prompt that never completes must time out explicitly (no silent success/fallback)
    await expect(hermesAcpPrompt('please HANG forever')).rejects.toThrow(/timed out/i);

    // 3) THE REGRESSION: the next request must still succeed — the timeout must
    //    have cancelled the abandoned turn so the persistent process recovered.
    await expect(hermesAcpPrompt('again')).resolves.toBe('ok:again');
  }, 15_000);
});
