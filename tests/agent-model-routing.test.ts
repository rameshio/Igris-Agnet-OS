import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { openDb } from '@/lib/db';
import { createCustomAgent } from '@/lib/agents/custom';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { chatWithAgent } from '@/lib/agents/chat';

const prevLlm = process.env.LLM_PROVIDER;
beforeAll(() => {
  process.env.LLM_PROVIDER = 'stub';
});
afterAll(() => {
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NVIDIA_API_KEY;
});

function makeAgent(db: ReturnType<typeof openDb>, model: string) {
  return createCustomAgent(db, { name: 'T', departmentId: 'dept-comms', instructions: 'Be helpful.', model, tools: [], enabled: true });
}

describe('per-agent chat routed through the unified ModelRouter', () => {
  test('empty model → Hermes brain (unchanged default behavior)', async () => {
    const db = openDb(':memory:');
    const agent = makeAgent(db, '');
    const res = await chatWithAgent(db, allRuntimeAgents(db), agent.id, 'hi');
    expect(res.reply.length).toBeGreaterThan(0); // stub brain reply
  });

  test('legacy gateway-style model string still routes to the brain (backward compatible)', async () => {
    const db = openDb(':memory:');
    const agent = makeAgent(db, 'anthropic/claude-sonnet-5');
    const res = await chatWithAgent(db, allRuntimeAgents(db), agent.id, 'hi');
    expect(res.reply.length).toBeGreaterThan(0);
  });

  test('fixed providerId:modelId routes to the direct provider adapter', async () => {
    const db = openDb(':memory:');
    process.env.NVIDIA_API_KEY = 'k';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'from nvidia' } }] }) })));
    const agent = makeAgent(db, 'nvidia:nemotron');
    const res = await chatWithAgent(db, allRuntimeAgents(db), agent.id, 'hi');
    expect(res.reply).toBe('from nvidia');
  });

  test('fixed provider with no credential fails clearly (no silent fallback)', async () => {
    const db = openDb(':memory:');
    const agent = makeAgent(db, 'nvidia:nemotron');
    await expect(chatWithAgent(db, allRuntimeAgents(db), agent.id, 'hi')).rejects.toThrow(/API key/i);
  });
});
