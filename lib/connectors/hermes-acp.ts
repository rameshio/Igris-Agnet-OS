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
 * Config (read from process env):
 *   HERMES_ACP_BIN        CLI (default: "hermes")
 *   HERMES_ACP_TIMEOUT_MS per-prompt timeout (default 180000)
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

function bin(): string {
  return process.env.HERMES_ACP_BIN?.trim() || 'hermes';
}
function timeoutMs(): number {
  return Number(process.env.HERMES_ACP_TIMEOUT_MS) || 180_000;
}

/** Send a JSON-RPC request and await its response result. */
function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc?.stdin.write(line);
  });
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
    const child = spawn(bin(), ['acp', '--accept-hooks', '-y'], { windowsHide: true });
    proc = child;
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
      for (const [, p] of pending) p.reject(new Error('Hermes ACP process exited'));
      pending.clear();
      proc = null;
      ready = null;
    };
    child.on('error', teardown);
    child.on('close', teardown);

    await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
  })();
  return ready;
}

/** Run one prompt in a fresh session; resolve with the assistant's full text. */
async function promptOnce(prompt: string): Promise<string> {
  await ensureReady();
  const sess = (await request('session/new', { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
  const sid = sess.sessionId;
  sessionText.set(sid, '');
  try {
    const done = request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: prompt }] });
    const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Hermes ACP timed out')), timeoutMs()));
    await Promise.race([done, timer]);
    return (sessionText.get(sid) ?? '').trim();
  } finally {
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

export function createHermesAcpProvider(): LlmProvider {
  return {
    name: 'hermes-acp',
    async chat(req) {
      const text = await hermesAcpPrompt(buildPrompt(req.system, req.messages));
      return { text, toolCalls: [] };
    },
  };
}
