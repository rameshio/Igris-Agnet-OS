import { afterEach, describe, expect, test, vi } from 'vitest';
import { HermesServeTransport, HermesTransportError, type ServeChannel } from '@/lib/connectors/hermes-serve';
import { FakeHermesServe } from './fixtures/fake-hermes-serve';

const user = (content: string) => ({ messages: [{ role: 'user' as const, content }] });

function transport(fake: FakeHermesServe, opts: { token?: string; timeoutMs?: number; capture?: (ch: ServeChannel) => void } = {}) {
  const token = opts.token ?? 'tok';
  return new HermesServeTransport({
    baseUrl: 'http://127.0.0.1:9',
    token,
    timeoutMs: opts.timeoutMs ?? 5000,
    connect: async () => {
      const ch = fake.channel(token); // throws on bad token → connect rejects
      opts.capture?.(ch);
      return ch;
    },
    fetchStatus: async () => fake.status(),
  });
}

afterEach(() => vi.restoreAllMocks());

describe('HermesServeTransport spike vs fake serve (H1)', () => {
  test('1. health via /api/status → ready + independentProbe', async () => {
    const h = await transport(new FakeHermesServe()).health();
    expect(h.status).toBe('ready');
    expect(h.transport).toBe('serve');
    expect(h.independentProbe).toBe(true);
    expect(h.detail).toContain('0.20.0');
  });

  test('2-8. authenticated connect → session.create → prompt.submit → delta accumulation → message.complete', async () => {
    const r = await transport(new FakeHermesServe()).chat(user('hello'));
    expect(r.text).toContain('hello');
    expect(r.text.startsWith('ok:')).toBe(true);
    expect(r.transport).toBe('serve');
    expect(r.brainName).toBe('hermes-serve');
  });

  test('3. bad/missing token → hermes_auth_error', async () => {
    const fake = new FakeHermesServe({ expectedToken: 'good' });
    await expect(transport(fake, { token: 'bad' }).chat(user('hello'))).rejects.toMatchObject({ code: 'hermes_auth_error' });
  });

  test('7. tool.start/tool.complete events do not break response collection', async () => {
    const r = await transport(new FakeHermesServe()).chat(user('please use a TOOL'));
    expect(r.text).toContain('ok:');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ name: 'echo', result: 'tool-ok' });
  });

  test('9-10. two concurrent sessions correlate independently', async () => {
    const fake = new FakeHermesServe();
    const [a, b] = await Promise.all([transport(fake).chat(user('alpha')), transport(fake).chat(user('beta'))]);
    expect(a.text).toContain('alpha');
    expect(b.text).toContain('beta');
  });

  test('11-12. timeout triggers session.interrupt, then a later request recovers', async () => {
    const fake = new FakeHermesServe();
    const t = transport(fake, { timeoutMs: 300 });
    await expect(t.chat(user('please HANG'))).rejects.toMatchObject({ code: 'hermes_timeout' });
    expect(fake.interruptedSessions.length).toBeGreaterThan(0); // interrupt was sent
    const r = await t.chat(user('hello')); // recovery
    expect(r.text).toContain('hello');
  });

  test('13. server-side error event → hermes_protocol_error', async () => {
    await expect(transport(new FakeHermesServe()).chat(user('trigger an ERROR'))).rejects.toMatchObject({ code: 'hermes_protocol_error' });
  });

  test('14. unknown/malformed method → clean JSON-RPC error, server stays usable', async () => {
    const fake = new FakeHermesServe();
    const ch = fake.channel('tok');
    const gotError = new Promise<string>((resolve) => ch.onMessage((f) => { if (f.error) resolve(f.error.message ?? ''); }));
    ch.send({ jsonrpc: '2.0', id: 'x', method: 'bogus.method' });
    expect(await gotError).toContain('unknown method');
    // still usable:
    const r = await transport(fake).chat(user('hello'));
    expect(r.text).toContain('hello');
  });

  test('15. connection loss mid-turn → hermes_unavailable', async () => {
    const fake = new FakeHermesServe();
    let held: ServeChannel | undefined;
    const t = transport(fake, { timeoutMs: 5000, capture: (ch) => (held = ch) });
    const p = t.chat(user('please HANG'));
    await new Promise((r) => setTimeout(r, 25)); // let it connect + submit
    held?.close();
    await expect(p).rejects.toMatchObject({ code: 'hermes_unavailable' });
  });

  test('serve capabilities keep MCP/skills unknown (H0 not verified)', () => {
    const caps = transport(new FakeHermesServe()).capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.cancellation).toBe(true);
    expect(caps.multiSession).toBe(true);
    expect(caps.mcp).toBe('unknown');
    expect(caps.skills).toBe('unknown');
  });
});

describe('HermesServeTransport security (token never leaks)', () => {
  const SECRET = 'super-secret-session-token-abc123';

  test('a token embedded in a transport error is redacted', async () => {
    const fake = new FakeHermesServe({ expectedToken: 'good' }); // channel() throws an Error containing the bad token
    try {
      await transport(fake, { token: SECRET }).chat(user('hello'));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HermesTransportError);
      expect((err as Error).message).not.toContain(SECRET);
      expect((err as Error).message).toContain('[redacted');
    }
  });

  test('the token never appears in the result object', async () => {
    const r = await transport(new FakeHermesServe(), { token: SECRET }).chat(user('hello'));
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect((r as Record<string, unknown>).token).toBeUndefined();
  });

  test('the token is never written to the console', async () => {
    const spyErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    await transport(new FakeHermesServe(), { token: SECRET }).chat(user('hello'));
    for (const spy of [spyErr, spyLog]) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET);
  });
});
