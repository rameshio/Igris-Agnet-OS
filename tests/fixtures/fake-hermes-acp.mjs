/**
 * Fake Hermes ACP agent for tests. Speaks newline-delimited JSON-RPC 2.0 over
 * stdio, exactly like a real `hermes acp` process, so the connector can be
 * exercised with `HERMES_ACP_BIN=node HERMES_ACP_ARGS=<this file>` — no Hermes
 * install, cross-platform.
 *
 * It models a SINGLE-TURN-BUSY agent (like the real one): a prompt whose text
 * contains "HANG" occupies the agent and never completes on its own. Any later
 * prompt QUEUES behind it (this is the "poisoning" the bug caused) UNLESS the
 * busy turn is released by a `session/cancel`. So: with cancellation the agent
 * recovers; without it, every later prompt stalls. Never logs prompt text.
 */
let sessionCounter = 0;
let busySession = null;
let busyPromptId = null;
const queued = []; // { id, sessionId, text }
let buf = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignore non-JSON */
      }
    }
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function result(id, res) {
  send({ jsonrpc: '2.0', id, result: res });
}
function streamAndFinish(id, sessionId, text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  });
  result(id, { stopReason: 'end_turn' });
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return result(id, { protocolVersion: 1 });
  if (method === 'session/new') return result(id, { sessionId: 's' + ++sessionCounter });

  if (method === 'session/prompt') {
    const sessionId = params?.sessionId;
    const text = params?.prompt?.[0]?.text ?? '';
    if (text.includes('HANG')) {
      // Occupy the single agent turn and never answer — the client must time out.
      busySession = sessionId;
      busyPromptId = id;
      return;
    }
    if (busySession !== null) {
      // Agent is still busy on the abandoned turn → this prompt stalls (poisoned).
      queued.push({ id, sessionId, text });
      return;
    }
    return streamAndFinish(id, sessionId, 'ok:' + text);
  }

  if (method === 'session/cancel') {
    if (params?.sessionId === busySession) {
      if (busyPromptId !== null) result(busyPromptId, { stopReason: 'cancelled' });
      busySession = null;
      busyPromptId = null;
      // The agent is free again — drain anything that queued behind the busy turn.
      for (const q of queued.splice(0)) streamAndFinish(q.id, q.sessionId, 'ok:' + q.text);
    }
    return;
  }
  // Any other agent-directed request is ignored by this fake.
}
