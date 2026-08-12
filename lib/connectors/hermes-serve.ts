/**
 * HermesServeTransport — TEST-ONLY / SPIKE (HRA-2, H1). NOT wired to production.
 *
 * A HermesClient-compatible implementation of Hermes' `serve` transport, speaking
 * the protocol H0 verified against Hermes v0.20.0: WebSocket + JSON-RPC 2.0 at
 * `/api/ws?token=…`, health at `GET /api/status`, `session.create` → `prompt.submit`
 * → stream `message.*`/`tool.*` → `message.complete`, and `session.interrupt` for
 * cancellation. It exists ONLY to prove the `HermesClient` seam can support the
 * future H3 transport swap. Nothing in the app selects it; the ModelRouter still
 * uses the ACP-backed client.
 *
 * Transport is injected via `connect()` + `fetchStatus()` so tests drive it with a
 * deterministic in-memory fake (no real Hermes, no ports), while a real manual
 * smoke uses `createServeConfig()` (global WebSocket + fetch).
 *
 * Token handling: the dashboard session token is INJECTED via config, never
 * hardcoded, never logged, never persisted. Every surfaced error is token-redacted.
 * Production token lifecycle is UNRESOLVED and required before H3 (H2 owns it).
 */
import type { HermesChatRequest, HermesChatResult, HermesClient, HermesHealth } from '@/lib/connectors/hermes-client';
import { HERMES_CAPABILITIES, type HermesCapabilities } from '@/lib/connectors/hermes-caps';
import type { LlmMessage, LlmToolCall } from '@/lib/connectors/llm';

export type ServeFrame = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string; code?: number };
};

/** A bidirectional JSON-RPC frame channel (a real WS, or an in-memory fake). */
export interface ServeChannel {
  send(frame: ServeFrame): void;
  onMessage(cb: (frame: ServeFrame) => void): void;
  onClose(cb: (reason?: string) => void): void;
  close(): void;
}

export type ServeStatus = { version?: string; overall?: string; gateway_state?: string; active_sessions?: number; auth_required?: boolean };

export interface ServeTransportConfig {
  /** e.g. http://127.0.0.1:9119 — used only to build the manual-smoke channel. */
  baseUrl: string;
  /** Injected dashboard session token. NEVER logged/persisted. */
  token: string;
  /** Overall per-request budget (back-compat default). */
  timeoutMs?: number;
  /** Layered timeouts (H3). Fall back to `timeoutMs` when unset. */
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** No stream event for this long → treat the turn as stalled (0 = disabled). */
  inactivityTimeoutMs?: number;
  /** `session.create` source label — each chat gets a FRESH session (isolation). */
  sessionSource?: string;
  /** Safe diagnostics sink (SAFE metadata only — never token/prompt/secret). */
  onDiag?: (meta: Record<string, unknown>) => void;
  /** Open an authenticated channel (real WS or fake). Rejects on auth failure. */
  connect: () => Promise<ServeChannel>;
  /** GET /api/status (real fetch or fake). */
  fetchStatus: () => Promise<ServeStatus>;
}

export type HermesTransportErrorCode =
  | 'hermes_timeout'
  | 'hermes_auth_error'
  | 'hermes_connect_error'
  | 'hermes_protocol_error'
  | 'hermes_unavailable'
  | 'hermes_interrupted'
  | 'hermes_approval_required';

export class HermesTransportError extends Error {
  constructor(
    public readonly code: HermesTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HermesTransportError';
  }
}

/** Strip a known token (and any `token=` query value) from a message before surfacing it. */
export function redactToken(message: string, token: string): string {
  let out = message;
  if (token) out = out.split(token).join('[redacted-token]');
  return out.replace(/token=[^\s&"']+/gi, 'token=[redacted]');
}

/** Fold system + conversation into the single prompt string serve expects. */
function buildPrompt(system: string | undefined, messages: LlmMessage[]): string {
  const convo = messages
    .filter((m) => m.role !== 'tool')
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
  return [system, convo].filter(Boolean).join('\n\n');
}

/** Per-connection JSON-RPC correlation + turn/event accumulation. */
class ChannelDriver {
  private nextId = 0;
  private readonly pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly turnHandlers = new Set<(ev: { type: string; session_id?: string; payload?: any }) => void>();
  private closed = false;

  constructor(
    private readonly ch: ServeChannel,
    private readonly token: string,
  ) {
    ch.onMessage((f) => this.onFrame(f));
    ch.onClose(() => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new HermesTransportError('hermes_unavailable', 'serve connection closed'));
      this.pending.clear();
      for (const h of [...this.turnHandlers]) h({ type: '__closed' });
    });
  }

  private onFrame(f: ServeFrame): void {
    // Response to one of our requests (id + result|error).
    if (f.id != null && (f.result !== undefined || f.error !== undefined)) {
      const p = this.pending.get(String(f.id));
      if (!p) return;
      this.pending.delete(String(f.id));
      clearTimeout(p.timer);
      if (f.error) p.reject(new HermesTransportError('hermes_protocol_error', redactToken(f.error.message ?? 'rpc error', this.token)));
      else p.resolve(f.result);
      return;
    }
    // Server → client event notification.
    if (f.method && f.params) {
      const ev = { type: (f.params.type as string) ?? f.method, session_id: f.params.session_id as string | undefined, payload: f.params.payload };
      for (const h of [...this.turnHandlers]) h(ev);
    }
  }

  call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (this.closed) return Promise.reject(new HermesTransportError('hermes_unavailable', 'serve connection closed'));
    const id = `h${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HermesTransportError('hermes_timeout', `${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ch.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  interrupt(sessionId: string): void {
    this.ch.send({ jsonrpc: '2.0', id: `i${this.nextId++}`, method: 'session.interrupt', params: { session_id: sessionId } });
  }

  /**
   * Collect one turn's streamed output. Resolves on message.complete; rejects on
   * error/close/timeout. Two liveness timers (H3): an OVERALL request budget and a
   * per-event INACTIVITY timer (reset on each stream event) — a turn emitting
   * events stays alive up to the budget; a silent turn fails on inactivity. Both
   * send `session.interrupt` so serve frees the turn (H0 recovery). Approval
   * events (`approval.request`/`sudo.request`/`secret.request`) are NOT
   * auto-answered — they fail with `hermes_approval_required`. Phase E ships
   * native Human Approval NODES (durable pause/resume in the flow engine), but
   * resuming a Hermes SESSION mid-turn after a human decision is DEFERRED: the
   * verified serve protocol exposes no approve/reject continuation RPC. We never
   * auto-approve; a Hermes-originated request surfaces honestly and stops there.
   */
  collectTurn(
    sessionId: string,
    overallMs: number,
    inactivityMs: number,
    onTimeout: () => void,
    onDiag?: (meta: Record<string, unknown>) => void,
  ): Promise<{ text: string; toolCalls: LlmToolCall[]; lastEventAt: number }> {
    return new Promise((resolve, reject) => {
      let text = '';
      let lastEventAt = Date.now();
      const toolCalls: LlmToolCall[] = [];
      const openTools = new Map<unknown, { name: string }>();
      let inactTimer: ReturnType<typeof setTimeout> | undefined;
      const clearAll = () => {
        clearTimeout(overallTimer);
        if (inactTimer) clearTimeout(inactTimer);
        this.turnHandlers.delete(handler);
      };
      const stall = (reason: string) => {
        clearAll();
        onTimeout(); // interrupt so the runtime frees the turn (never restarts Hermes)
        reject(new HermesTransportError('hermes_timeout', reason));
      };
      const overallTimer = setTimeout(() => stall('serve turn exceeded request budget'), overallMs);
      const armInactivity = () => {
        if (inactTimer) clearTimeout(inactTimer);
        if (inactivityMs > 0) inactTimer = setTimeout(() => stall('serve turn produced no stream activity (inactivity timeout)'), inactivityMs);
      };
      armInactivity();
      const handler = (ev: { type: string; session_id?: string; payload?: any }) => {
        if (ev.session_id && ev.session_id !== sessionId) return; // correlation by session_id
        lastEventAt = Date.now();
        armInactivity(); // any event proves liveness
        const p = ev.payload ?? {};
        if (ev.type === '__closed') { clearAll(); reject(new HermesTransportError('hermes_unavailable', 'serve connection lost mid-turn')); return; }
        if (ev.type === 'approval.request' || ev.type === 'sudo.request' || ev.type === 'secret.request') {
          clearAll();
          onTimeout(); // stop the turn; do NOT auto-answer the approval
          reject(new HermesTransportError('hermes_approval_required', `Hermes requested ${ev.type} — Hermes-native approval continuation is deferred; never auto-approved. Use a Human Approval node for a durable gate.`));
          return;
        }
        if (ev.type === 'message.delta' || ev.type === 'message.interim') text += p.text ?? p.delta ?? p.content ?? p.chunk ?? '';
        if (ev.type === 'tool.start') openTools.set(p.id ?? p.tool ?? toolCalls.length, { name: p.name ?? p.tool ?? 'tool' });
        if (ev.type === 'tool.complete') {
          const startedTool = openTools.get(p.id ?? p.tool);
          toolCalls.push({ name: startedTool?.name ?? p.name ?? 'tool', args: p.args ?? {}, result: p.result });
        }
        if (ev.type === 'message.complete' || ev.type === 'background.complete') { clearAll(); resolve({ text: text.trim(), toolCalls, lastEventAt }); }
        if (ev.type === 'error') { clearAll(); reject(new HermesTransportError('hermes_protocol_error', redactToken(String(p.message ?? JSON.stringify(p)).slice(0, 200), this.token))); }
      };
      this.turnHandlers.add(handler);
      void onDiag;
    });
  }
}

/** Race a promise against a timeout that rejects. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class HermesServeTransport implements HermesClient {
  readonly transport = 'serve' as const;
  constructor(private readonly cfg: ServeTransportConfig) {}

  private get timeoutMs(): number {
    return this.cfg.timeoutMs ?? 180_000;
  }

  capabilities(): HermesCapabilities {
    return HERMES_CAPABILITIES.serve;
  }

  async health(): Promise<HermesHealth> {
    try {
      const s = await this.cfg.fetchStatus();
      const ok = s.overall === 'ok' || s.gateway_state === 'running';
      return { status: ok ? 'ready' : 'unavailable', transport: 'serve', independentProbe: true, detail: s.version ? `v${s.version}` : undefined };
    } catch {
      return { status: 'unavailable', transport: 'serve', independentProbe: true, detail: 'status probe failed' };
    }
  }

  async chat(req: HermesChatRequest): Promise<HermesChatResult> {
    const prompt = buildPrompt(req.system, req.messages);
    const connectMs = this.cfg.connectTimeoutMs ?? 15_000;
    const requestMs = this.cfg.requestTimeoutMs ?? this.timeoutMs;
    const inactivityMs = this.cfg.inactivityTimeoutMs ?? 0;
    const source = this.cfg.sessionSource ?? 'igris'; // fresh session per chat → workflow isolation
    const started = Date.now();

    let ch: ServeChannel;
    try {
      ch = await withTimeout(this.cfg.connect(), connectMs, 'serve connect');
    } catch (err) {
      // Distinguish an auth rejection (bad/missing token) from a transport failure.
      const msg = err instanceof Error ? err.message : String(err);
      const code: HermesTransportErrorCode = /401|403|unauthor|forbidden|token/i.test(msg) ? 'hermes_auth_error' : 'hermes_connect_error';
      throw new HermesTransportError(code, redactToken(msg, this.cfg.token));
    }
    const driver = new ChannelDriver(ch, this.cfg.token);
    try {
      const created = await driver.call('session.create', { cols: 96, source }, requestMs);
      const sid = String((created as { session_id?: string }).session_id ?? '');
      this.cfg.onDiag?.({ event: 'session_created', transport: 'serve', sessionId: sid });
      // Start collecting BEFORE submitting so no early event is missed.
      const turn = driver.collectTurn(sid, requestMs, inactivityMs, () => driver.interrupt(sid), this.cfg.onDiag);
      await driver.call('prompt.submit', { session_id: sid, text: prompt }, requestMs);
      const { text, toolCalls, lastEventAt } = await turn;
      this.cfg.onDiag?.({ event: 'complete', transport: 'serve', sessionId: sid, elapsedMs: Date.now() - started, lastEventAt, toolCalls: toolCalls.length });
      return { text, toolCalls, transport: 'serve', brainName: 'hermes-serve' };
    } finally {
      ch.close();
    }
  }
}

// ── Real channel factory — backs the production serve client AND manual smoke ──

export type ServeConfigOptions = {
  timeoutMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  sessionSource?: string;
  onDiag?: (meta: Record<string, unknown>) => void;
};

/** Build a ServeTransportConfig backed by a real WebSocket + fetch. */
export function createServeConfig(baseUrl: string, token: string, opts: ServeConfigOptions = {}): ServeTransportConfig {
  const wsUrl = baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '') + `/api/ws?token=${encodeURIComponent(token)}`;
  return {
    baseUrl,
    token,
    timeoutMs: opts.timeoutMs,
    connectTimeoutMs: opts.connectTimeoutMs,
    requestTimeoutMs: opts.requestTimeoutMs,
    inactivityTimeoutMs: opts.inactivityTimeoutMs,
    sessionSource: opts.sessionSource,
    onDiag: opts.onDiag,
    fetchStatus: async () => {
      const r = await fetch(baseUrl.replace(/\/+$/, '') + '/api/status');
      return (await r.json()) as ServeStatus;
    },
    connect: () =>
      new Promise<ServeChannel>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const messageCbs = new Set<(f: ServeFrame) => void>();
        const closeCbs = new Set<(r?: string) => void>();
        ws.addEventListener('message', (m: MessageEvent) => {
          let f: ServeFrame;
          try {
            f = JSON.parse(String(m.data));
          } catch {
            return;
          }
          for (const cb of messageCbs) cb(f);
        });
        ws.addEventListener('close', () => {
          for (const cb of closeCbs) cb();
        });
        ws.addEventListener('error', () => reject(new Error('serve websocket connection failed')));
        ws.addEventListener('open', () =>
          resolve({
            send: (frame) => ws.send(JSON.stringify(frame)),
            onMessage: (cb) => messageCbs.add(cb),
            onClose: (cb) => closeCbs.add(cb),
            close: () => ws.close(),
          }),
        );
        setTimeout(() => reject(new Error('serve websocket open timeout')), 15_000);
      }),
  };
}
