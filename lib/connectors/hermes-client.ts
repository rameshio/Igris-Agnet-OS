/**
 * HermesClient — the canonical Hermes application-facing seam (HRA-2).
 *
 * The ModelRouter's `hermes` strategy talks to Hermes through THIS interface. The
 * concrete transport is chosen HERE (not in React, not in the ModelRouter):
 *
 *   getHermesClient(db)
 *     ├── production transport == 'serve'  → HermesServeTransport (H3, selectable)
 *     └── otherwise                        → BrainHermesClient → active brain (ACP default)
 *
 * The transport is an explicit, reversible setting (`meta.hermes_production_transport`,
 * default `'acp'`). There is NO silent fallback: if serve is selected and fails,
 * the call surfaces a Hermes error — it never quietly switches to ACP. Scope of
 * chat/health/capabilities only; process lifecycle/discovery/token live in
 * `HermesRuntimeManager` (H2).
 */
import { getLlmProvider, type LlmChatRequest, type LlmChatResult, type LlmProvider } from '@/lib/connectors/llm';
import { hermesAcpProcessSpawned } from '@/lib/connectors/hermes-acp';
import { HermesServeTransport, createServeConfig } from '@/lib/connectors/hermes-serve';
import { readEnvLocal } from '@/lib/creds';
import { HERMES_CAPABILITIES, type HermesCapabilities, type HermesTransport, type Tri } from '@/lib/connectors/hermes-caps';

export { HERMES_CAPABILITIES };
export type { HermesCapabilities, HermesTransport, Tri };

export interface HermesHealth {
  status: 'ready' | 'unknown' | 'unavailable';
  transport: HermesTransport;
  /** True only when a real out-of-band probe ran (serve). ACP has none — never faked. */
  independentProbe: boolean;
  detail?: string;
}

export type HermesChatRequest = LlmChatRequest;
/** Normalized result: the existing LLM result + which transport/brain served it. */
export type HermesChatResult = LlmChatResult & { transport: HermesTransport; brainName: string };

export interface HermesClient {
  readonly transport: HermesTransport;
  chat(req: HermesChatRequest): Promise<HermesChatResult>;
  health(): Promise<HermesHealth>;
  capabilities(): HermesCapabilities;
}

/** Minimal meta reader — the router already holds a FounderDb (structurally compatible). */
export type MetaReader = { get(key: string): string | null };
export type HermesConfigDb = { meta: MetaReader };
export type HermesTransportMode = 'acp' | 'serve';

/** The explicit, reversible production transport (default ACP). */
export function productionTransportMode(meta: MetaReader): HermesTransportMode {
  return meta.get('hermes_production_transport') === 'serve' ? 'serve' : 'acp';
}

function transportOf(providerName: string): HermesTransport {
  if (providerName === 'hermes-acp') return 'acp';
  if (providerName === 'hermes-cli') return 'cli';
  if (providerName === 'stub') return 'stub';
  return 'gateway';
}

/**
 * ACP/brain-backed client: wraps the active brain resolved by `getLlmProvider()`.
 * Resolved fresh per call so a brain switch takes effect without a restart.
 */
class BrainHermesClient implements HermesClient {
  constructor(private readonly provider: LlmProvider) {}

  get transport(): HermesTransport {
    return transportOf(this.provider.name);
  }

  async chat(req: HermesChatRequest): Promise<HermesChatResult> {
    const res = await this.provider.chat(req);
    return { ...res, transport: this.transport, brainName: this.provider.name };
  }

  async health(): Promise<HermesHealth> {
    const t = this.transport;
    if (t === 'acp') {
      return { status: 'unknown', transport: 'acp', independentProbe: false, detail: hermesAcpProcessSpawned() ? 'process spawned' : 'process not started' };
    }
    if (t === 'stub') return { status: 'ready', transport: 'stub', independentProbe: false, detail: 'deterministic test stub' };
    return { status: 'unknown', transport: t, independentProbe: false };
  }

  capabilities(): HermesCapabilities {
    return HERMES_CAPABILITIES[this.transport];
  }
}

// ── Bounded serve concurrency (H3) — a process-wide semaphore so IGRIS never
//    fires unlimited concurrent agent turns at serve; each turn is an independent
//    session, so requests never share a mutable buffer. On globalThis to survive
//    Next per-route bundling. ────────────────────────────────────────────────
export const DEFAULT_SERVE_CONCURRENCY = 3;
type Limiter = { limit: number; active: number; queue: (() => void)[] };
declare global {
  // eslint-disable-next-line no-var
  var __igrisServeLimiter: Limiter | undefined;
}
function limiter(): Limiter {
  return (globalThis.__igrisServeLimiter ??= { limit: DEFAULT_SERVE_CONCURRENCY, active: 0, queue: [] });
}
async function runLimited<T>(fn: () => Promise<T>): Promise<T> {
  const l = limiter();
  if (l.active >= l.limit) await new Promise<void>((r) => l.queue.push(r));
  l.active++;
  try {
    return await fn();
  } finally {
    l.active--;
    l.queue.shift()?.();
  }
}
/** Test-only: reset the serve concurrency limiter. */
export function __resetServeLimiterForTest(): void {
  globalThis.__igrisServeLimiter = undefined;
}
/** Test-only: set the serve concurrency limit. */
export function __setServeLimitForTest(n: number): void {
  limiter().limit = n;
}
/** Run a task under the process-wide serve concurrency limit (exported for tests). */
export function runServeLimited<T>(fn: () => Promise<T>): Promise<T> {
  return runLimited(fn);
}

/** Serve-backed client: bounded concurrency + a fresh isolated session per chat. */
class ServeHermesClient implements HermesClient {
  readonly transport = 'serve' as const;
  constructor(private readonly inner: HermesServeTransport) {}
  chat(req: HermesChatRequest): Promise<HermesChatResult> {
    return runLimited(() => this.inner.chat(req));
  }
  health(): Promise<HermesHealth> {
    return this.inner.health();
  }
  capabilities(): HermesCapabilities {
    return this.inner.capabilities();
  }
}

const serveDiag = (meta: Record<string, unknown>): void => {
  if (!process.env.HERMES_SERVE_DEBUG) return;
  try {
    console.error('[hermes-serve]', JSON.stringify(meta)); // SAFE metadata only (no token/prompt)
  } catch {
    /* logging must never throw */
  }
};

function buildServeClient(db: HermesConfigDb): HermesClient {
  const host = db.meta.get('hermes_runtime_host') || '127.0.0.1';
  const port = Number(db.meta.get('hermes_runtime_port')) || 9119;
  const token = readEnvLocal().HERMES_SERVE_TOKEN || '';
  const limit = Number(db.meta.get('hermes_serve_concurrency')) || DEFAULT_SERVE_CONCURRENCY;
  limiter().limit = limit;
  const cfg = createServeConfig(`http://${host}:${port}`, token, {
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 300_000, // generous for cold, tool-using agents
    inactivityTimeoutMs: 90_000, // no stream event for 90s → stalled
    sessionSource: 'igris-agent', // fresh session per chat → workflow isolation
    onDiag: serveDiag,
  });
  return new ServeHermesClient(new HermesServeTransport(cfg));
}

/**
 * The canonical Hermes seam. With `db` and production transport `serve`, returns the
 * serve client; otherwise the active brain (ACP in production). Without `db` (tests
 * / non-router callers) it always uses the brain path — behavior unchanged from H1.
 */
export function getHermesClient(db?: HermesConfigDb): HermesClient {
  if (db && productionTransportMode(db.meta) === 'serve') return buildServeClient(db);
  return new BrainHermesClient(getLlmProvider());
}
