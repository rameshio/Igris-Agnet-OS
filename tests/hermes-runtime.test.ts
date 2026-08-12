import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HermesRuntimeManager, __resetManagedRecordForTest, type RuntimeDeps } from '@/lib/connectors/hermes-runtime';

const HERMES_BANNER = 'Hermes Agent v0.20.0 (2026.8.3)\nPython: 3.11.15';
const hermesStatus = (over: Record<string, unknown> = {}) => ({
  version: '0.20.0',
  overall: 'ok',
  gateway_mode: 'single',
  components: { gateway: { status: 'ok' } },
  auth_required: false,
  active_sessions: 0,
  profiles: ['default', 'gmail-agent'],
  ...over,
});

function fakeDeps(over: Partial<RuntimeDeps> = {}) {
  const metaMap = new Map<string, string>();
  const tokenStore: { token?: string } = {};
  const deps: RuntimeDeps = {
    runVersion: async () => ({ ok: false, stdout: '' }), // default: not installed
    fetchStatus: async () => {
      throw new Error('ECONNREFUSED'); // default: serve unreachable
    },
    spawnServe: () => ({ pid: 4242, onExit: () => {} }),
    killPid: () => {},
    pidAlive: () => false,
    fileExists: () => false,
    env: () => ({}),
    now: () => '2026-08-10T00:00:00.000Z',
    randomToken: () => 'GENERATED_TOKEN_abc',
    meta: { get: (k) => metaMap.get(k) ?? null, set: (k, v) => void metaMap.set(k, v) },
    readToken: () => tokenStore.token,
    writeToken: (t) => void (tokenStore.token = t),
    sleep: async () => {},
    ...over,
  };
  return { deps, metaMap, tokenStore };
}

beforeEach(() => __resetManagedRecordForTest());
afterEach(() => vi.restoreAllMocks());

describe('HermesRuntimeManager — discovery', () => {
  test('1. explicit configured binary path is discovered', async () => {
    const { deps, metaMap } = fakeDeps({ fileExists: () => true, runVersion: async (b) => ({ ok: b === 'C:/x/hermes.exe', stdout: HERMES_BANNER }) });
    metaMap.set('hermes_runtime_bin', 'C:/x/hermes.exe');
    const bin = await new HermesRuntimeManager(deps).discover();
    expect(bin).toMatchObject({ installed: true, path: 'C:/x/hermes.exe', source: 'configured', version: '0.20.0' });
  });

  test('2. PATH binary is discovered', async () => {
    const { deps } = fakeDeps({ runVersion: async (b) => ({ ok: b === 'hermes', stdout: HERMES_BANNER }) });
    const bin = await new HermesRuntimeManager(deps).discover();
    expect(bin).toMatchObject({ installed: true, path: 'hermes', source: 'path' });
  });

  test('3. known Windows install location is discovered', async () => {
    const known = path.join('C:/Users/x/AppData/Local', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe');
    const { deps } = fakeDeps({
      env: () => ({ LOCALAPPDATA: 'C:/Users/x/AppData/Local' }),
      fileExists: (p) => p === known,
      runVersion: async (b) => ({ ok: b === known, stdout: HERMES_BANNER }),
    });
    const bin = await new HermesRuntimeManager(deps).discover();
    expect(bin).toMatchObject({ installed: true, source: 'known_location' });
  });

  test('4. a candidate that is not really Hermes is rejected', async () => {
    const { deps } = fakeDeps({ fileExists: () => true, runVersion: async () => ({ ok: true, stdout: 'GNU bash, version 5.2' }) });
    expect(await new HermesRuntimeManager(deps).discover()).toMatchObject({ installed: false });
  });

  test('5. missing binary → not_installed', async () => {
    const status = await new HermesRuntimeManager(fakeDeps().deps).status();
    expect(status.installed).toBe(false);
    expect(status.state).toBe('not_installed');
  });

  test('6. version is parsed from the CLI banner', async () => {
    const { deps } = fakeDeps({ runVersion: async () => ({ ok: true, stdout: HERMES_BANNER }) });
    const bin = await new HermesRuntimeManager(deps).discover();
    expect(bin.version).toBe('0.20.0');
    expect(bin.versionParsed).toBe(true);
  });
});

describe('HermesRuntimeManager — serve health + identity', () => {
  const installed = { runVersion: async () => ({ ok: true, stdout: HERMES_BANNER }) };

  test('7. reachable Hermes serve → healthy', async () => {
    const { deps } = fakeDeps({ ...installed, fetchStatus: async () => hermesStatus() });
    const s = await new HermesRuntimeManager(deps).status();
    expect(s.serveReachable).toBe(true);
    expect(s.state).toBe('healthy');
  });

  test('8. status endpoint unavailable → not reachable, installed state', async () => {
    const { deps } = fakeDeps(installed);
    const s = await new HermesRuntimeManager(deps).status();
    expect(s.serveReachable).toBe(false);
    expect(s.state).toBe('installed');
  });

  test('9. a non-Hermes 200 response is NOT trusted as Hermes', async () => {
    const { deps } = fakeDeps({ ...installed, fetchStatus: async () => ({ hello: 'world' }) });
    const h = await new HermesRuntimeManager(deps).probe();
    expect(h.reachable).toBe(true);
    expect(h.isHermes).toBe(false);
    expect((await new HermesRuntimeManager(deps).status()).state).toBe('unreachable');
  });

  test('17-19. shared/external metadata: version, gateway_mode, profiles captured; no managed process', async () => {
    const { deps } = fakeDeps({ ...installed, fetchStatus: async () => hermesStatus() });
    const s = await new HermesRuntimeManager(deps).status();
    expect(s.ownership).toBe('external');
    expect(s.managedProcess).toBeNull();
    expect(s.health?.gatewayMode).toBe('single');
    expect(s.health?.profiles).toEqual(['default', 'gmail-agent']);
    expect(s.version).toBe('0.20.0');
  });

  test('14. health timestamps are recorded', async () => {
    const { deps, metaMap } = fakeDeps({ ...installed, fetchStatus: async () => hermesStatus() });
    await new HermesRuntimeManager(deps).health();
    expect(metaMap.get('hermes_runtime_last_check')).toBeTruthy();
    expect(metaMap.get('hermes_runtime_last_success')).toBeTruthy();
  });

  test('15. probe error is token-redacted', async () => {
    const { deps } = fakeDeps({ ...installed, readToken: () => 'SECRET_TOKEN_123', fetchStatus: async () => { throw new Error('connect failed token=SECRET_TOKEN_123'); } });
    const h = await new HermesRuntimeManager(deps).probe();
    expect(h.error).not.toContain('SECRET_TOKEN_123');
  });
});

describe('HermesRuntimeManager — ownership + lifecycle', () => {
  const installed = { runVersion: async () => ({ ok: true, stdout: HERMES_BANNER }) };

  test('10. managed ownership after IGRIS starts serve; 12. stop targets the owned PID only', async () => {
    let up = false;
    const killed: number[] = [];
    const { deps } = fakeDeps({
      ...installed,
      fetchStatus: async () => {
        if (!up) throw new Error('ECONNREFUSED');
        return hermesStatus();
      },
      spawnServe: () => {
        up = true;
        return { pid: 4242, onExit: () => {} };
      },
      pidAlive: (pid) => up && pid === 4242,
      killPid: (pid) => {
        killed.push(pid);
        up = false;
      },
    });
    const mgr = new HermesRuntimeManager(deps);
    const started = await mgr.startManaged();
    expect(started.ownership).toBe('managed');
    expect(started.managedProcess?.pid).toBe(4242);
    await mgr.stopManaged();
    expect(killed).toEqual([4242]); // only our PID, never `serve --stop`
  });

  test('11. an external/shared runtime cannot be stopped', async () => {
    const { deps } = fakeDeps({ ...installed, fetchStatus: async () => hermesStatus() }); // healthy but not ours
    await expect(new HermesRuntimeManager(deps).stopManaged()).rejects.toMatchObject({ code: 'not_managed' });
  });

  test('startManaged attaches (does NOT relaunch) when a healthy Hermes already runs', async () => {
    let spawned = 0;
    const { deps } = fakeDeps({ ...installed, fetchStatus: async () => hermesStatus(), spawnServe: () => { spawned++; return { pid: 1, onExit: () => {} }; } });
    const s = await new HermesRuntimeManager(deps).startManaged();
    expect(spawned).toBe(0); // never launched a competing server
    expect(s.ownership).toBe('external');
  });

  test('13. a non-Hermes service on the port → port_conflict (never killed)', async () => {
    const killed: number[] = [];
    const { deps } = fakeDeps({ ...installed, fetchStatus: async () => ({ notHermes: true }), killPid: (p) => killed.push(p) });
    await expect(new HermesRuntimeManager(deps).startManaged()).rejects.toMatchObject({ code: 'port_conflict' });
    expect(killed).toEqual([]);
  });
});

describe('HermesRuntimeManager — token lifecycle', () => {
  const installed = { runVersion: async () => ({ ok: true, stdout: HERMES_BANNER }) };

  test('managed start generates a token, passes it via ENV (not argv), never the DB', async () => {
    let up = false;
    let capturedArgs: string[] = [];
    let capturedEnv: Record<string, string> = {};
    const { deps, metaMap, tokenStore } = fakeDeps({
      ...installed,
      fetchStatus: async () => (up ? hermesStatus() : Promise.reject(new Error('down'))),
      spawnServe: (_bin, args, env) => {
        up = true;
        capturedArgs = args;
        capturedEnv = env;
        return { pid: 7, onExit: () => {} };
      },
      pidAlive: () => up,
    });
    await new HermesRuntimeManager(deps).startManaged();
    expect(tokenStore.token).toBe('GENERATED_TOKEN_abc'); // written to .env.local (fake)
    expect(capturedEnv.HERMES_DASHBOARD_SESSION_TOKEN).toBe('GENERATED_TOKEN_abc');
    expect(capturedArgs.join(' ')).not.toContain('GENERATED_TOKEN_abc'); // never on the command line
    for (const v of metaMap.values()) expect(v).not.toContain('GENERATED_TOKEN_abc'); // never in the DB/meta
  });

  test('16. status reports token presence only — never the raw token', async () => {
    const { deps } = fakeDeps({ ...installed, readToken: () => 'RAW_TOKEN_should_never_leak', fetchStatus: async () => hermesStatus() });
    const s = await new HermesRuntimeManager(deps).status();
    expect(s.tokenConfigured).toBe(true);
    expect(JSON.stringify(s)).not.toContain('RAW_TOKEN_should_never_leak');
  });

  test('missing token is shown honestly (tokenConfigured=false)', async () => {
    const { deps } = fakeDeps(installed);
    expect((await new HermesRuntimeManager(deps).status()).tokenConfigured).toBe(false);
  });

  test('configure writes an external token to .env.local only, never echoed', async () => {
    const { deps, metaMap, tokenStore } = fakeDeps();
    new HermesRuntimeManager(deps).configure({ mode: 'external_local', token: 'USER_TOKEN_xyz' });
    expect(tokenStore.token).toBe('USER_TOKEN_xyz');
    for (const v of metaMap.values()) expect(v).not.toContain('USER_TOKEN_xyz');
  });
});

describe('HermesRuntimeManager — status contract + security', () => {
  test('production transport is ACP; memory flagged persistent; supported unknown; caps tri-state', async () => {
    const { deps } = fakeDeps({ runVersion: async () => ({ ok: true, stdout: HERMES_BANNER }), fetchStatus: async () => hermesStatus() });
    const s = await new HermesRuntimeManager(deps).status();
    expect(s.productionTransport).toBe('acp');
    expect(s.memory.persistentAcrossSessions).toBe(true);
    expect(s.supported).toBe('unknown');
    expect(s.capabilities.mcp).toBe('unknown');
    expect(s.capabilities.skills).toBe('unknown');
  });

  test('serve eligibility: healthy + token configured → eligible', async () => {
    const { deps } = fakeDeps({ runVersion: async () => ({ ok: true, stdout: HERMES_BANNER }), fetchStatus: async () => hermesStatus(), readToken: () => 'a-token' });
    const s = await new HermesRuntimeManager(deps).status();
    expect(s.eligibility.eligible).toBe(true);
    expect(s.eligibility.reasons).toEqual([]);
  });

  test('serve eligibility: missing token / unreachable → ineligible with reasons', async () => {
    const { deps } = fakeDeps({ runVersion: async () => ({ ok: true, stdout: HERMES_BANNER }) }); // unreachable, no token
    const s = await new HermesRuntimeManager(deps).status();
    expect(s.eligibility.eligible).toBe(false);
    expect(s.eligibility.reasons.join(' ')).toMatch(/reachable|token/i);
  });

  test('production transport defaults to acp; reads meta when set to serve', async () => {
    const { deps, metaMap } = fakeDeps({ runVersion: async () => ({ ok: true, stdout: HERMES_BANNER }) });
    expect((await new HermesRuntimeManager(deps).status()).productionTransport).toBe('acp');
    metaMap.set('hermes_production_transport', 'serve');
    expect((await new HermesRuntimeManager(deps).status()).productionTransport).toBe('serve');
  });

  test('20 + injection guard: code uses no `serve --status` and no shell execution', () => {
    // Strip comments so we assert about CODE, not the docstring that names the guard.
    const code = readFileSync(path.join(process.cwd(), 'lib/connectors/hermes-runtime.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '');
    expect(code).not.toMatch(/serve\s+--status/); // never use serve --status for liveness
    expect(code).not.toMatch(/shell:\s*true/); // spawn/execFile with argv only, never a shell
    // argv-array execution only: the shell `exec` is never imported from child_process.
    const cpImports = /import\s*\{([^}]*)\}\s*from\s*['"]node:child_process['"]/.exec(code)?.[1] ?? '';
    expect(cpImports.split(',').map((s) => s.trim())).not.toContain('exec');
  });
});
