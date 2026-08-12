/**
 * Persistent Hermes brain over ACP (Agent Client Protocol).
 *
 * Instead of spawning `hermes chat` per request — which pays a ~31s Python
 * cold-start every time — we start ONE long-lived `hermes acp` process and
 * drive it with newline-delimited JSON-RPC 2.0 over stdio (the same protocol
 * Zed / VS Code use). The boot cost is paid once; every later prompt is warm,
 * and the full Hermes stack (tools, MCP, memory, skills) stays live.
 *
 * Each prompt runs in its own ACP session so IGRIS's stateless per-call design
 * is preserved (no context bleed between unrelated Conductor questions). The
 * client auto-approves tool permissions so MCP tool-calls don't block.
 *
 * Timeout & recovery: each prompt is bounded by HERMES_ACP_TIMEOUT_MS. On a
 * timeout the client sends an ACP `session/cancel` for that session and drops the
 * pending correlation, so the abandoned turn does NOT keep the shared process
 * busy — the NEXT prompt runs on a freed process. A timeout surfaces explicitly
 * (`hermes_unavailable`) and never silently falls back to another model.
 *
 * Config (read from process env):
 *   HERMES_ACP_BIN        CLI (default: "hermes")
 *   HERMES_ACP_ARGS       spawn args (default: "acp --accept-hooks -y")
 *   HERMES_ACP_TIMEOUT_MS per-prompt AND setup timeout (default 180000)
 *   HERMES_ACP_DEBUG      set to log per-prompt start/success diagnostics
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LlmProvider, LlmMessage } from '@/lib/connectors/llm';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

let proc: ChildProcessWithoutNullStreams | null = null;
let ready: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
// accumulated assistant text per in-flight session
const sessionText = new Map<string, string>();
// serialize prompts — one ACP session/prompt processes at a time
let queue: Promise<unknown> = Promise.resolve();
// monotonic id for diagnostic correlation (distinct from the JSON-RPC id)
let correlationSeq = 0;

function bin(): string {
  return process.env.HERMES_ACP_BIN?.trim() || 'hermes';
}
/** ACP spawn args. Overridable (default `acp --accept-hooks -y`) — lets tests inject a fake agent. */
function acpArgs(): string[] {
  const override = process.env.HERMES_ACP_ARGS?.trim();
  return override ? override.split(/\s+/) : ['acp', '--accept-hooks', '-y'];
}
function timeoutMs(): number {
  return Number(process.env.HERMES_ACP_TIMEOUT_MS) || 180_000;
}

/** Operational diagnostics — SAFE metadata only (never prompt text, keys, or headers). */
function diag(meta: Record<string, unknown>, debugOnly = false): void {
  if (debugOnly && !process.env.HERMES_ACP_DEBUG) return;
  try {
    console.error('[hermes-acp]', JSON.stringify(meta));
  } catch {
    /* logging must never throw */
  }
}

/** Is the persistent ACP process actually alive right now? */
function procAlive(): boolean {
  return !!proc && proc.exitCode === null && proc.signalCode === null && !proc.killed;
}

/** Drop a correlation entry and reject its awaiter — used on timeout/cancel so nothing leaks. */
function cleanupPending(id: number, err: Error): void {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  p.reject(err);
}

/**
 * Send a JSON-RPC request; return the correlation `id` + the response promise.
 * An optional timeout rejects AND removes the pending entry, so a slow/lost
 * response never leaks. The stored resolve/reject clear the timer, so the happy
 * path leaves no dangling timer.
 */
function sendRequest(method: string, params: unknown, timeout = 0): { id: number; promise: Promise<any> } {
  const id = nextId++;
  const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  const promise = new Promise<any>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    pending.set(id, {
      resolve: (v) => {
        if (timer) clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        if (timer) clearTimeout(timer);
        reject(e as Error);
      },
    });
    if (timeout > 0) timer = setTimeout(() => cleanupPending(id, new Error(`${method} timed out`)), timeout);
    proc?.stdin.write(line);
  });
  return { id, promise };
}

/** Send a JSON-RPC request and await its result (optionally bounded by a timeout). */
function request(method: string, params: unknown, timeout = 0): Promise<any> {
  return sendRequest(method, params, timeout).promise;
}

/** Fire-and-forget JSON-RPC notification (no id / no response) — e.g. session/cancel. */
function notify(method: string, params: unknown): void {
  proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

/** Reply to an agent→client request (permission, fs, terminal, …). */
function reply(id: number, result: unknown): void {
  proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id: number, message: string): void {
  proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\n');
}

/** Route one parsed JSON-RPC message from the agent. */
function handleMessage(msg: any): void {
  // response to one of our requests
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'ACP error'));
    else p.resolve(msg.result);
    return;
  }
  // agent→client request (needs a reply, or it hangs)
  if (msg.id !== undefined && msg.method) {
    if (msg.method === 'session/request_permission') {
      const opts: any[] = msg.params?.options ?? [];
      const allow = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? '')) ?? opts[0];
      reply(msg.id, { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } });
    } else {
      // fs/*, terminal/* etc. — we declared no such capabilities
      replyError(msg.id, `${msg.method} not supported`);
    }
    return;
  }
  // notification — collect streamed assistant text
  if (msg.method === 'session/update') {
    const sid = msg.params?.sessionId;
    const upd = msg.params?.update;
    if (sid && upd?.sessionUpdate === 'agent_message_chunk' && upd.content?.type === 'text') {
      sessionText.set(sid, (sessionText.get(sid) ?? '') + upd.content.text);
    }
  }
}

/** Spawn the ACP process (once) and run the initialize handshake. */
async function ensureReady(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(bin(), acpArgs(), { windowsHide: true });
    proc = child;
    diag({ event: 'spawn', pid: child.pid });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          /* non-JSON log line on stdout — ignore */
        }
      }
    });
    child.stderr.on('data', () => {
      /* Hermes logs to stderr — swallow */
    });
    const teardown = () => {
      diag({ event: 'process_exit', exitCode: child.exitCode, signal: child.signalCode, pendingDropped: pending.size });
      for (const [, p] of pending) p.reject(new Error('Hermes ACP process exited'));
      pending.clear();
      proc = null;
      ready = null;
    };
    child.on('error', teardown);
    child.on('close', teardown);

    // Bound the handshake so a hung boot surfaces as an error instead of hanging forever.
    await request(
      'initialize',
      { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
      timeoutMs(),
    );
  })();
  return ready;
}

/** Run one prompt in a fresh session; resolve with the assistant's full text. */
async function promptOnce(prompt: string): Promise<string> {
  const reqId = ++correlationSeq;
  const started = Date.now();
  await ensureReady();
  const sess = (await request('session/new', { cwd: process.cwd(), mcpServers: [] }, timeoutMs())) as { sessionId: string };
  const sid = sess.sessionId;
  sessionText.set(sid, '');
  diag({ event: 'prompt_start', reqId, sessionId: sid }, true);

  // Track the prompt's correlation id so a timeout can cancel + clean it up.
  const { id: promptRpcId, promise: done } = sendRequest('session/prompt', {
    sessionId: sid,
    prompt: [{ type: 'text', text: prompt }],
  });
  const TIMED_OUT = Symbol('timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<typeof TIMED_OUT>((res) => {
    timer = setTimeout(() => res(TIMED_OUT), timeoutMs());
  });

  try {
    const outcome = await Promise.race([done.then(() => 'done' as const), timed]);
    if (outcome === TIMED_OUT) {
      // CRITICAL: free the persistent process. Tell Hermes to stop the abandoned
      // turn (else it stays busy and the next prompt stalls too), and drop our
      // leaked correlation so a late response can't touch anything.
      notify('session/cancel', { sessionId: sid });
      cleanupPending(promptRpcId, new Error('prompt cancelled after timeout'));
      diag({ event: 'timeout', reqId, sessionId: sid, elapsedMs: Date.now() - started, timeoutMs: timeoutMs(), procAlive: procAlive() });
      throw new Error('Hermes ACP timed out');
    }
    const text = (sessionText.get(sid) ?? '').trim();
    diag({ event: 'prompt_success', reqId, sessionId: sid, elapsedMs: Date.now() - started, chars: text.length }, true);
    return text;
  } finally {
    if (timer) clearTimeout(timer); // no dangling timer on success OR failure
    sessionText.delete(sid);
  }
}

/** Serialized entry point — one prompt at a time over the shared process. */
export function hermesAcpPrompt(prompt: string): Promise<string> {
  const run = queue.then(() => promptOnce(prompt));
  // keep the chain alive even if this prompt rejects
  queue = run.catch(() => undefined);
  return run;
}

function buildPrompt(system: string | undefined, messages: LlmMessage[]): string {
  const convo = messages
    .filter((m) => m.role !== 'tool')
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
  return [system, convo].filter(Boolean).join('\n\n');
}

/**
 * Read-only introspection for the HermesClient seam (H1): is the persistent ACP
 * process currently spawned? This is NOT a health claim — ACP has no independent
 * health channel — only an honest "process exists" hint.
 */
export function hermesAcpProcessSpawned(): boolean {
  return procAlive();
}

/** Kill the persistent ACP process and reset state (graceful shutdown / test cleanup). */
export function shutdownHermesAcp(): void {
  for (const [, p] of pending) p.reject(new Error('Hermes ACP shut down'));
  pending.clear();
  try {
    proc?.kill();
  } catch {
    /* already gone */
  }
  proc = null;
  ready = null;
}

export function createHermesAcpProvider(): LlmProvider {
  return {
    name: 'hermes-acp',
    async chat(req) {
      const text = await hermesAcpPrompt(buildPrompt(req.system, req.messages));
      return { text, toolCalls: [] };
    },
  };
}
