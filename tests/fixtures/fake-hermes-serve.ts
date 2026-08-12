/**
 * Deterministic in-memory fake of Hermes `serve`, for HRA-2 H1 tests. Implements
 * just enough of the H0-verified protocol to exercise HermesServeTransport with NO
 * real Hermes, NO ports, NO sockets. Prompt text markers drive behavior:
 *   "HANG"  → streams a delta then never completes (for timeout/interrupt tests)
 *   "ERROR" → emits an error event
 *   "TOOL"  → emits tool.start/tool.complete around the reply
 *   else    → streams "ok:<last line>" in two deltas, then message.complete
 */
import type { ServeChannel, ServeFrame, ServeStatus } from '@/lib/connectors/hermes-serve';

export class FakeHermesServe {
  private sessionCounter = 0;
  readonly liveSessions = new Set<string>();
  readonly interruptedSessions: string[] = [];

  constructor(private readonly opts: { expectedToken?: string; version?: string } = {}) {}

  status(): ServeStatus {
    return { version: this.opts.version ?? '0.20.0', overall: 'ok', gateway_state: 'running', active_sessions: this.liveSessions.size, auth_required: false };
  }

  /** Open a channel; throws (→ connect rejects) if the session token is wrong (serve /api/ws auth). */
  channel(token: string): ServeChannel {
    if (this.opts.expectedToken != null && token !== this.opts.expectedToken) {
      throw new Error(`401 unauthorized for ws://fake/api/ws?token=${token}`);
    }
    return new FakeChannel(this);
  }

  nextSessionId(): string {
    return 's' + ++this.sessionCounter;
  }
}

class FakeChannel implements ServeChannel {
  private readonly messageCbs = new Set<(f: ServeFrame) => void>();
  private readonly closeCbs = new Set<(r?: string) => void>();
  private closed = false;
  private readonly hanging = new Map<string, boolean>();

  constructor(private readonly serve: FakeHermesServe) {}

  onMessage(cb: (f: ServeFrame) => void): void {
    this.messageCbs.add(cb);
  }
  onClose(cb: (r?: string) => void): void {
    this.closeCbs.add(cb);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb('closed');
  }

  private emit(frame: ServeFrame): void {
    if (this.closed) return;
    setTimeout(() => {
      if (this.closed) return;
      for (const cb of this.messageCbs) cb(frame);
    }, 1);
  }
  private event(type: string, sessionId: string, payload?: unknown): void {
    this.emit({ jsonrpc: '2.0', method: 'event', params: { type, session_id: sessionId, payload } });
  }

  send(frame: ServeFrame): void {
    if (this.closed) return;
    const { id, method, params = {} } = frame;
    if (!method) {
      if (id != null) this.emit({ jsonrpc: '2.0', id, error: { message: 'malformed request: missing method' } });
      return;
    }
    if (method === 'session.create') {
      const sid = this.serve.nextSessionId();
      this.serve.liveSessions.add(sid);
      this.emit({ jsonrpc: '2.0', id, result: { session_id: sid, stored_session_id: 'stored_' + sid, message_count: 0, messages: [], info: {} } });
      return;
    }
    if (method === 'prompt.submit') {
      const sid = String(params.session_id ?? '');
      const text = String(params.text ?? '');
      this.emit({ jsonrpc: '2.0', id, result: { status: 'ok' } }); // ack
      this.streamTurn(sid, text);
      return;
    }
    if (method === 'session.interrupt') {
      const sid = String(params.session_id ?? '');
      this.serve.interruptedSessions.push(sid);
      this.hanging.delete(sid);
      this.emit({ jsonrpc: '2.0', id, result: { status: 'interrupted' } });
      // A hung turn ends on interrupt (real serve frees the turn).
      this.event('message.complete', sid, { interrupted: true });
      return;
    }
    // Unknown method → clean JSON-RPC error; server stays alive.
    if (id != null) this.emit({ jsonrpc: '2.0', id, error: { message: `unknown method: ${method}` } });
  }

  private streamTurn(sid: string, text: string): void {
    this.event('message.start', sid, {});
    if (text.includes('ERROR')) {
      this.event('error', sid, { message: 'simulated server-side turn error' });
      return;
    }
    if (text.includes('TOOL')) {
      this.event('tool.start', sid, { id: 't1', name: 'echo' });
      this.event('tool.complete', sid, { id: 't1', name: 'echo', result: 'tool-ok' });
    }
    if (text.includes('APPROVAL')) {
      this.event('approval.request', sid, { tool: 'shell', prompt: 'approve?' }); // must NOT be auto-answered
      return;
    }
    if (text.includes('SILENT')) {
      // one event, then no further activity → exercises the inactivity timeout
      return;
    }
    if (text.includes('HANG')) {
      this.hanging.set(sid, true);
      this.event('message.delta', sid, { text: 'partial…' });
      return; // never completes until interrupt
    }
    const reply = 'ok:' + (text.split('\n').pop() ?? '');
    const mid = Math.ceil(reply.length / 2);
    this.event('message.delta', sid, { text: reply.slice(0, mid) });
    this.event('message.delta', sid, { text: reply.slice(mid) });
    this.event('reasoning.available', sid, {});
    this.event('message.complete', sid, {});
  }
}
