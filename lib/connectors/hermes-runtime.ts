/**
 * HermesRuntimeManager (HRA-2, H2) — understands and (safely) manages the LOCAL
 * Hermes runtime environment. Orthogonal to the production transport: the
 * ModelRouter still routes agent chat through HermesClient → ACP. This subsystem
 * only DISCOVERS, reports STATUS/HEALTH, models the lifecycle, and — with strict
 * ownership guards — can start/stop an IGRIS-managed `hermes serve` instance. It
 * does NOT construct prompts, choose model strategy, or run workflows.
 *
 * Hard rules baked in here:
 *  - A 200 on the port is NOT ownership. Only a process IGRIS launched, whose PID
 *    is still alive, is `managed`; anything else reachable is `external`.
 *  - Never `hermes serve --stop` (it stops ALL servers). Stop kills only our PID.
 *  - The serve dashboard token lives ONLY in .env.local — never in SQLite, never
 *    returned to the frontend, never logged. The UI sees `tokenConfigured` only.
 *  - `/api/status` is the canonical health probe — never `serve --status`.
 *  - No approved minimum version yet → `supported` is always `'unknown'`.
 *
 * Fully dependency-injected (`RuntimeDeps`) so tests use fakes — the default test
 * suite never spawns a process or hits a network.
 */
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { HERMES_CAPABILITIES, type HermesCapabilities } from '@/lib/connectors/hermes-caps';
import { productionTransportMode, type HermesTransportMode } from '@/lib/connectors/hermes-client';
import { redactToken } from '@/lib/connectors/hermes-serve';
import { readEnvLocal, upsertEnvLocal } from '@/lib/creds';

export type RuntimeState =
  | 'not_installed'
  | 'installed'
  | 'starting'
  | 'healthy'
  | 'degraded'
  | 'unreachable'
  | 'stopped'
  | 'crashed';
export type RuntimeMode = 'managed_local' | 'external_local' | 'remote';
export type Ownership = 'managed' | 'external' | 'unknown';

const STATUS_TIMEOUT_MS = 4_000;
const READY_TIMEOUT_MS = 30_000;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 9119;
/** Reserved for future compatibility gating; unset today → `supported` stays 'unknown'. */
export const MIN_SUPPORTED_VERSION: string | null = null;

export type RuntimeConfig = { mode: RuntimeMode; binPath?: string; host: string; port: number; enabled: boolean };

export type BinaryInfo = {
  installed: boolean;
  path?: string;
  version?: string;
  versionParsed: boolean;
  source?: 'configured' | 'path' | 'known_location';
};

export type ServeHealth = {
  reachable: boolean;
  /** `/api/status` actually looks like Hermes (§31) — a bare 200 is not enough. */
  isHermes: boolean;
  overall?: string;
  version?: string;
  gatewayMode?: string;
  authRequired?: boolean;
  activeSessions?: number;
  profiles?: string[];
  error?: string;
};

export type ManagedProcessMeta = { pid: number; host: string; port: number; startedAt: string; mode: 'managed_local' };

export type RuntimeStatus = {
  state: RuntimeState;
  mode: RuntimeMode;
  ownership: Ownership;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  supported: 'unknown';
  endpoint: { host: string; port: number };
  serveReachable: boolean;
  health: ServeHealth | null;
  capabilities: HermesCapabilities;
  /** Selected production transport (default 'acp'). H3 makes 'serve' selectable. */
  productionTransport: HermesTransportMode;
  /** Whether serve may be selected as the production transport right now, and why not. */
  eligibility: { eligible: boolean; reasons: string[] };
  tokenConfigured: boolean;
  memory: { persistentAcrossSessions: true; note: string };
  managedProcess: ManagedProcessMeta | null;
  lastCheckAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
};

export type RuntimeErrorCode = 'not_installed' | 'not_managed' | 'port_conflict' | 'start_failed';
export class RuntimeError extends Error {
  constructor(
    public readonly code: RuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeError';
  }
}

/** A spawned managed serve process the manager can observe and kill by PID. */
export type SpawnedServe = { pid?: number; onExit: (cb: (code: number | null) => void) => void };

export type RuntimeDeps = {
  runVersion: (bin: string) => Promise<{ ok: boolean; stdout: string }>;
  fetchStatus: (url: string, timeoutMs: number) => Promise<unknown>;
  spawnServe: (bin: string, args: string[], env: Record<string, string>) => SpawnedServe;
  killPid: (pid: number) => void;
  pidAlive: (pid: number) => boolean;
  fileExists: (p: string) => boolean;
  env: () => Record<string, string | undefined>;
  now: () => string;
  randomToken: () => string;
  meta: { get(k: string): string | null; set(k: string, v: string): void };
  readToken: () => string | undefined;
  writeToken: (token: string) => void;
  sleep: (ms: number) => Promise<void>;
};

const MEMORY_NOTE =
  'Hermes maintains its own persistent memory across sessions, independent of IGRIS G-Brain. IGRIS never auto-writes to G-Brain, but Hermes may still retain conversational memory. This is an open product decision before serve reaches users.';

// ── Managed-process record: on globalThis so it survives Next per-route bundling
//    (same lesson as INC-001). Only a process WE launched appears here. ──────────
type ManagedRecord = { pid: number; host: string; port: number; startedAt: string; stoppedCleanly: boolean };
declare global {
  // eslint-disable-next-line no-var
  var __igrisHermesManaged: ManagedRecord | null | undefined;
}
function getManaged(): ManagedRecord | null {
  return globalThis.__igrisHermesManaged ?? null;
}
function setManaged(r: ManagedRecord | null): void {
  globalThis.__igrisHermesManaged = r;
}
/** Test-only: clear the managed-process singleton. */
export function __resetManagedRecordForTest(): void {
  globalThis.__igrisHermesManaged = null;
}

function parseVersion(stdout: string): string | undefined {
  return /v?(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
}

function knownLocations(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'));
  const home = env.HOME ?? env.USERPROFILE;
  if (home) {
    out.push(path.join(home, '.local', 'bin', 'hermes'));
    out.push(path.join(home, '.hermes', 'bin', 'hermes'));
  }
  return out;
}

export class HermesRuntimeManager {
  constructor(private readonly deps: RuntimeDeps) {}

  config(): RuntimeConfig {
    const m = this.deps.meta;
    const modeRaw = m.get('hermes_runtime_mode');
    const mode: RuntimeMode = modeRaw === 'managed_local' || modeRaw === 'remote' ? modeRaw : 'external_local';
    return {
      mode,
      binPath: m.get('hermes_runtime_bin') ?? undefined,
      host: m.get('hermes_runtime_host') ?? DEFAULT_HOST,
      port: Number(m.get('hermes_runtime_port')) || DEFAULT_PORT,
      enabled: m.get('hermes_runtime_enabled') !== '0',
    };
  }

  /** Persist NON-secret runtime config to `meta`; a supplied token goes to .env.local only. */
  configure(patch: { mode?: RuntimeMode; host?: string; port?: number; binPath?: string; enabled?: boolean; token?: string }): void {
    const m = this.deps.meta;
    if (patch.mode) m.set('hermes_runtime_mode', patch.mode);
    if (patch.host) m.set('hermes_runtime_host', patch.host);
    if (patch.port != null) m.set('hermes_runtime_port', String(patch.port));
    if (patch.binPath != null) m.set('hermes_runtime_bin', patch.binPath);
    if (patch.enabled != null) m.set('hermes_runtime_enabled', patch.enabled ? '1' : '0');
    if (patch.token && patch.token.trim()) this.deps.writeToken(patch.token.trim()); // NEVER the DB
  }

  /** Discover the Hermes binary: configured/HERMES_BIN → PATH → known locations. A candidate
   *  is accepted ONLY if `<bin> --version` prints a Hermes banner (never trust mere existence). */
  async discover(): Promise<BinaryInfo> {
    const cfg = this.config();
    const candidates: { p: string; source: BinaryInfo['source'] }[] = [];
    const configured = cfg.binPath ?? this.deps.env().HERMES_BIN;
    if (configured) candidates.push({ p: configured, source: 'configured' });
    candidates.push({ p: 'hermes', source: 'path' });
    for (const loc of knownLocations(this.deps.env())) candidates.push({ p: loc, source: 'known_location' });

    for (const c of candidates) {
      if (c.source !== 'path' && !this.deps.fileExists(c.p)) continue;
      const r = await this.deps.runVersion(c.p);
      if (r.ok && /hermes/i.test(r.stdout)) {
        const version = parseVersion(r.stdout);
        return { installed: true, path: c.p, version, versionParsed: version != null, source: c.source };
      }
    }
    return { installed: false, versionParsed: false };
  }

  /** Canonical health probe — GET /api/status (bounded). Validates the response is Hermes-shaped. */
  async probe(): Promise<ServeHealth> {
    const { host, port } = this.config();
    const url = `http://${host}:${port}/api/status`;
    try {
      const j = (await this.deps.fetchStatus(url, STATUS_TIMEOUT_MS)) as Record<string, unknown>;
      const isHermes =
        !!j && typeof j === 'object' && 'version' in j && ('components' in j || 'gateway_mode' in j || 'gateway_state' in j);
      return {
        reachable: true,
        isHermes,
        overall: typeof j.overall === 'string' ? j.overall : undefined,
        version: typeof j.version === 'string' ? j.version : undefined,
        gatewayMode: typeof j.gateway_mode === 'string' ? j.gateway_mode : undefined,
        authRequired: typeof j.auth_required === 'boolean' ? j.auth_required : undefined,
        activeSessions: typeof j.active_sessions === 'number' ? j.active_sessions : undefined,
        profiles: Array.isArray(j.profiles) ? (j.profiles as string[]) : undefined,
      };
    } catch (e) {
      return { reachable: false, isHermes: false, error: redactToken(e instanceof Error ? e.message : String(e), this.deps.readToken() ?? '') };
    }
  }

  private ownership(health: ServeHealth): Ownership {
    const rec = getManaged();
    const { host, port } = this.config();
    if (rec && rec.host === host && rec.port === port && this.deps.pidAlive(rec.pid)) return 'managed';
    if (health.reachable && health.isHermes) return 'external';
    return 'unknown';
  }

  private computeState(bin: BinaryInfo, health: ServeHealth): RuntimeState {
    if (!bin.installed) return 'not_installed';
    if (health.reachable && health.isHermes) return health.overall === 'ok' ? 'healthy' : 'degraded';
    if (health.reachable && !health.isHermes) return 'unreachable'; // non-Hermes service on the port
    const rec = getManaged();
    if (rec && !this.deps.pidAlive(rec.pid)) return rec.stoppedCleanly ? 'stopped' : 'crashed';
    return 'installed'; // binary present, serve not running
  }

  /** Full truthful status: discovery + health + ownership + state + caps + token + memory. */
  async status(): Promise<RuntimeStatus> {
    const cfg = this.config();
    const [bin, health] = [await this.discover(), await this.probe()];
    const ownership = this.ownership(health);
    const state = this.computeState(bin, health);
    const rec = getManaged();
    const tokenConfigured = !!this.deps.readToken();

    // Serve eligibility for the H3 transport switch: healthy + Hermes-shaped + token.
    const reasons: string[] = [];
    if (!(health.reachable && health.isHermes)) reasons.push('serve endpoint is not reachable or not Hermes');
    else if (state !== 'healthy') reasons.push('serve runtime is not healthy');
    if (!tokenConfigured) reasons.push('serve session token is not configured');
    const eligibility = { eligible: reasons.length === 0, reasons };

    this.deps.meta.set('hermes_runtime_last_check', this.deps.now());
    if (health.reachable && health.isHermes) this.deps.meta.set('hermes_runtime_last_success', this.deps.now());
    if (health.error) this.deps.meta.set('hermes_runtime_last_error', health.error);
    if (bin.version) this.deps.meta.set('hermes_runtime_last_version', bin.version);

    return {
      state,
      mode: cfg.mode,
      ownership,
      installed: bin.installed,
      binaryPath: bin.path,
      version: bin.version,
      supported: 'unknown',
      endpoint: { host: cfg.host, port: cfg.port },
      serveReachable: health.reachable && health.isHermes,
      health,
      capabilities: HERMES_CAPABILITIES.serve,
      productionTransport: productionTransportMode(this.deps.meta),
      eligibility,
      tokenConfigured,
      memory: { persistentAcrossSessions: true, note: MEMORY_NOTE },
      managedProcess:
        ownership === 'managed' && rec ? { pid: rec.pid, host: rec.host, port: rec.port, startedAt: rec.startedAt, mode: 'managed_local' } : null,
      lastCheckAt: this.deps.meta.get('hermes_runtime_last_check') ?? undefined,
      lastSuccessAt: this.deps.meta.get('hermes_runtime_last_success') ?? undefined,
      lastError: this.deps.meta.get('hermes_runtime_last_error') ?? undefined,
    };
  }

  /** A one-shot health check (used by the "Check Health" action). */
  async health(): Promise<ServeHealth> {
    const h = await this.probe();
    this.deps.meta.set('hermes_runtime_last_check', this.deps.now());
    if (h.reachable && h.isHermes) this.deps.meta.set('hermes_runtime_last_success', this.deps.now());
    if (h.error) this.deps.meta.set('hermes_runtime_last_error', h.error);
    return h;
  }

  /**
   * Safely start an IGRIS-managed serve. If a healthy Hermes is already running it
   * is EXTERNAL/shared — we attach (report status), never launch or claim it. A
   * non-Hermes service on the port is a clear conflict (we never kill it). The
   * token is generated/reused in .env.local and passed to serve via ENV (never CLI).
   */
  async startManaged(): Promise<RuntimeStatus> {
    const cfg = this.config();
    const pre = await this.probe();
    if (pre.reachable && pre.isHermes) return this.status(); // external/shared — do not launch
    if (pre.reachable && !pre.isHermes) throw new RuntimeError('port_conflict', `Port ${cfg.port} is in use by a non-Hermes service.`);

    const bin = await this.discover();
    if (!bin.installed || !bin.path) throw new RuntimeError('not_installed', 'Hermes is not installed — cannot start a managed runtime.');

    let token = this.deps.readToken();
    if (!token) {
      token = this.deps.randomToken();
      this.deps.writeToken(token); // .env.local only
    }
    const child = this.deps.spawnServe(bin.path, ['serve', '--host', cfg.host, '--port', String(cfg.port), '--skip-build'], {
      HERMES_DASHBOARD_SESSION_TOKEN: token, // ENV, not argv — token never on the command line
    });
    setManaged({ pid: child.pid ?? -1, host: cfg.host, port: cfg.port, startedAt: this.deps.now(), stoppedCleanly: false });
    child.onExit((code) => {
      const rec = getManaged();
      if (rec) rec.stoppedCleanly = code === 0;
    });

    // Readiness = canonical /api/status, not the stdout marker alone.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const h = await this.probe();
      if (h.reachable && h.isHermes) return this.status();
      await this.deps.sleep(500);
    }
    throw new RuntimeError('start_failed', 'Managed Hermes serve did not become healthy in time.');
  }

  /** Stop ONLY the IGRIS-managed process, by PID. Never `serve --stop`; never an external/shared runtime. */
  async stopManaged(): Promise<RuntimeStatus> {
    const rec = getManaged();
    if (!rec) throw new RuntimeError('not_managed', 'No IGRIS-managed Hermes runtime to stop.');
    const health = await this.probe();
    if (this.ownership(health) !== 'managed') throw new RuntimeError('not_managed', 'Refusing to stop a Hermes runtime IGRIS does not own.');
    this.deps.killPid(rec.pid); // exact owned PID only
    rec.stoppedCleanly = true;
    setManaged(null);
    return this.status();
  }
}

/** Wire real implementations. Server-only (imported only by the API route + tests). */
export function defaultRuntimeDeps(meta: RuntimeDeps['meta']): RuntimeDeps {
  return {
    runVersion: (bin) =>
      new Promise((resolve) => {
        execFile(bin, ['--version'], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
          resolve({ ok: !err, stdout: String(stdout ?? '') });
        });
      }),
    fetchStatus: async (url, timeoutMs) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        return await r.json();
      } finally {
        clearTimeout(t);
      }
    },
    spawnServe: (bin, args, env) => {
      const child = spawn(bin, args, { windowsHide: true, env: { ...process.env, ...env }, stdio: 'ignore', detached: false });
      return { pid: child.pid, onExit: (cb) => child.on('exit', cb) };
    },
    killPid: (pid) => {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    },
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    fileExists: (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
    env: () => process.env,
    now: () => new Date().toISOString(),
    randomToken: () => crypto.randomBytes(24).toString('hex'),
    meta,
    readToken: () => readEnvLocal().HERMES_SERVE_TOKEN || undefined,
    writeToken: (token) => upsertEnvLocal({ HERMES_SERVE_TOKEN: token }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
