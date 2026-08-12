import { afterEach, describe, expect, test, vi } from 'vitest';
import { openDb } from '@/lib/db';
import {
  getHermesClient,
  __resetServeLimiterForTest,
  __setServeLimitForTest,
  runServeLimited,
} from '@/lib/connectors/hermes-client';
import { HermesServeTransport, type ServeTransportConfig } from '@/lib/connectors/hermes-serve';
import { routeModel } from '@/lib/models/router';
import { ModelRouteError } from '@/lib/models/types';
import { FakeHermesServe } from './fixtures/fake-hermes-serve';

const user = (content: string) => ({ messages: [{ role: 'user' as const, content }] });

function serveT(fake: FakeHermesServe, opts: Partial<ServeTransportConfig> & { token?: string } = {}) {
  const token = opts.token ?? 'tok';
  return new HermesServeTransport({
    baseUrl: 'http://127.0.0.1:9',
    token,
    timeoutMs: 5000,
    requestTimeoutMs: opts.requestTimeoutMs,
    inactivityTimeoutMs: opts.inactivityTimeoutMs,
    connect: opts.connect ?? (async () => fake.channel(token)),
    fetchStatus: async () => fake.status(),
  });
}

const prevLlm = process.env.LLM_PROVIDER;
afterEach(() => {
  __resetServeLimiterForTest();
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
  vi.unstubAllEnvs();
});

describe('H3 transport selection', () => {
  test('ACP/brain by default (no production_transport set)', () => {
    process.env.LLM_PROVIDER = 'stub';
    expect(getHermesClient(openDb(':memory:')).transport).toBe('stub');
  });
  test('serve when production_transport = serve', () => {
    const db = openDb(':memory:');
    db.meta.set('hermes_production_transport', 'serve');
    expect(getHermesClient(db).transport).toBe('serve');
  });
  test('no db → brain path (H1 back-compat)', () => {
    process.env.LLM_PROVIDER = 'stub';
    expect(getHermesClient().transport).toBe('stub');
  });
});

describe('H3 no silent fallback', () => {
  test('serve configured + dead endpoint → hermes_unavailable, NEVER an ACP/stub result', async () => {
    process.env.LLM_PROVIDER = 'stub'; // if it silently fell back, we would get stub text instead of a throw
    const db = openDb(':memory:');
    db.meta.set('hermes_production_transport', 'serve');
    db.meta.set('hermes_runtime_host', '127.0.0.1');
    db.meta.set('hermes_runtime_port', '9'); // nothing listening → connection refused
    await expect(routeModel(db, { strategy: 'hermes', config: {} }, user('hi'))).rejects.toBeInstanceOf(ModelRouteError);
    await routeModel(db, { strategy: 'hermes', config: {} }, user('hi')).catch((e) => {
      expect((e as ModelRouteError).code).toBe('hermes_unavailable');
    });
  }, 20_000);
});

describe('H3 bounded serve concurrency', () => {
  test('limit=1 serializes; limit=3 allows up to 3', async () => {
    let active = 0;
    let max = 0;
    const task = () =>
      runServeLimited(async () => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      });

    __resetServeLimiterForTest();
    __setServeLimitForTest(1);
    await Promise.all([task(), task(), task()]);
    expect(max).toBe(1);

    __resetServeLimiterForTest();
    __setServeLimitForTest(3);
    active = 0;
    max = 0;
    await Promise.all([task(), task(), task(), task()]);
    expect(max).toBe(3);
  });
});

describe('H3 serve transport behaviors', () => {
  test('approval.request → hermes_approval_required (never auto-answered)', async () => {
    const fake = new FakeHermesServe();
    await expect(serveT(fake).chat(user('this needs APPROVAL'))).rejects.toMatchObject({ code: 'hermes_approval_required' });
  });

  test('inactivity timeout → hermes_timeout + session.interrupt', async () => {
    const fake = new FakeHermesServe();
    const t = serveT(fake, { requestTimeoutMs: 5000, inactivityTimeoutMs: 200 });
    await expect(t.chat(user('go SILENT'))).rejects.toMatchObject({ code: 'hermes_timeout' });
    expect(fake.interruptedSessions.length).toBeGreaterThan(0);
  });

  test('transport connect failure → hermes_connect_error (distinct from auth)', async () => {
    const fake = new FakeHermesServe();
    const t = serveT(fake, { connect: async () => { throw new Error('ECONNREFUSED 127.0.0.1:9119'); } });
    await expect(t.chat(user('hi'))).rejects.toMatchObject({ code: 'hermes_connect_error' });
  });

  test('two concurrent sessions do not cross-talk', async () => {
    const fake = new FakeHermesServe();
    const [a, b] = await Promise.all([serveT(fake).chat(user('alpha')), serveT(fake).chat(user('beta'))]);
    expect(a.text).toContain('alpha');
    expect(b.text).toContain('beta');
  });
});
