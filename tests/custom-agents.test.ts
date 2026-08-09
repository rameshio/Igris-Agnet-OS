import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb, type FounderDb } from '@/lib/db';
import {
  buildCustomRuntimeAgent,
  createCustomAgent,
  customRuntimeAgents,
  updateCustomAgent,
} from '@/lib/agents/custom';
import type { LlmProvider } from '@/lib/connectors/llm';

// A deterministic, offline provider: echoes the last user message so we can
// assert run()/respond() actually drove the model with the agent's config.
const fakeProvider: LlmProvider = {
  name: 'fake',
  async chat(req) {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    return {
      text: `[${req.system}] ${lastUser?.content ?? ''}`,
      toolCalls: [],
      usage: { inputTokens: 11, outputTokens: 7 },
    };
  },
};

let db: FounderDb;
afterEach(() => db?.close());

describe('custom agent repo', () => {
  test('starts empty — a fresh client has no agents until they create one', () => {
    db = openDb(':memory:');
    expect(db.customAgents.all()).toEqual([]);
  });

  test('create assigns an id + timestamps and persists', () => {
    db = openDb(':memory:');
    const agent = createCustomAgent(db, {
      name: 'Lead Qualifier',
      departmentId: 'dept-sales',
      instructions: 'Qualify inbound leads and summarize fit.',
    });
    expect(agent.id).toMatch(/^custom-/);
    expect(agent.createdAt).toBeTruthy();
    expect(agent.enabled).toBe(true);
    expect(agent.description).toBe(''); // defaulted
    const stored = db.customAgents.get(agent.id);
    expect(stored?.name).toBe('Lead Qualifier');
  });

  test('update applies a partial change and bumps updatedAt', async () => {
    db = openDb(':memory:');
    const agent = createCustomAgent(db, {
      name: 'Draft',
      departmentId: 'dept-tech',
      instructions: 'Do a thing.',
    });
    await new Promise((r) => setTimeout(r, 2));
    const updated = updateCustomAgent(db, agent.id, { name: 'Renamed', enabled: false });
    expect(updated.name).toBe('Renamed');
    expect(updated.enabled).toBe(false);
    expect(updated.instructions).toBe('Do a thing.'); // untouched
    expect(updated.updatedAt >= agent.updatedAt).toBe(true);
  });

  test('update throws on an unknown agent', () => {
    db = openDb(':memory:');
    expect(() => updateCustomAgent(db, 'custom-nope', { name: 'x' })).toThrow(/unknown custom agent/i);
  });

  test('remove deletes the agent', () => {
    db = openDb(':memory:');
    const agent = createCustomAgent(db, { name: 'Temp', departmentId: 'dept-tech', instructions: 'x' });
    db.customAgents.remove(agent.id);
    expect(db.customAgents.get(agent.id)).toBeNull();
  });

  test('rejects an invalid payload at the boundary', () => {
    db = openDb(':memory:');
    expect(() => createCustomAgent(db, { name: '', departmentId: 'dept-tech', instructions: 'x' })).toThrow();
    expect(() => createCustomAgent(db, { name: 'ok', departmentId: 'dept-tech', instructions: '' })).toThrow();
    expect(() => createCustomAgent(db, { name: 'ok', instructions: 'x' })).toThrow(); // no department
  });
});

describe('custom agent runtime', () => {
  test('run() drives the model with the agent instructions', async () => {
    db = openDb(':memory:');
    const cfg = createCustomAgent(db, {
      name: 'Analyst',
      departmentId: 'dept-tech',
      instructions: 'You are a rigorous analyst.',
      model: 'anthropic/claude-sonnet-5',
    });
    const rt = buildCustomRuntimeAgent(cfg, fakeProvider);
    const result = await rt.run();
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('rigorous analyst'); // system prompt was applied
    expect(result.model).toBe('anthropic/claude-sonnet-5');
    expect(result.tokensIn).toBe(11);
    expect(result.tokensOut).toBe(7);
  });

  test('respond() answers a specific message', async () => {
    db = openDb(':memory:');
    const cfg = createCustomAgent(db, { name: 'Helper', departmentId: 'dept-tech', instructions: 'Be helpful.' });
    const rt = buildCustomRuntimeAgent(cfg, fakeProvider);
    const result = await rt.respond!('what is our churn?');
    expect(result.summary).toContain('what is our churn?');
  });

  test('a disabled agent refuses to run without calling the model', async () => {
    db = openDb(':memory:');
    const cfg = createCustomAgent(db, { name: 'Off', departmentId: 'dept-tech', instructions: 'x', enabled: false });
    let called = false;
    const spy: LlmProvider = { name: 'spy', async chat() { called = true; return { text: '', toolCalls: [] }; } };
    const result = await buildCustomRuntimeAgent(cfg, spy).run();
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/disabled/i);
    expect(called).toBe(false);
  });

  test('customRuntimeAgents reflects every stored row', () => {
    db = openDb(':memory:');
    createCustomAgent(db, { name: 'A', departmentId: 'dept-tech', instructions: 'a' });
    createCustomAgent(db, { name: 'B', departmentId: 'dept-sales', instructions: 'b' });
    const built = customRuntimeAgents(db, fakeProvider);
    expect(built.map((a) => a.name).sort()).toEqual(['A', 'B']);
    expect(built.every((a) => a.id.startsWith('custom-'))).toBe(true);
  });
});

describe('custom agent tools (the agentic part)', () => {
  test('stores the connected tool slugs', () => {
    db = openDb(':memory:');
    const a = createCustomAgent(db, {
      name: 'Toolful',
      departmentId: 'dept-tech',
      instructions: 'x',
      tools: ['slack', 'notion'],
    });
    expect(a.tools).toEqual(['slack', 'notion']);
    expect(db.customAgents.get(a.id)?.tools).toEqual(['slack', 'notion']);
  });

  test('only WIRED tools become callable, and they are handed to the model on a run', async () => {
    db = openDb(':memory:');
    const cfg = createCustomAgent(db, {
      name: 'Agentic',
      departmentId: 'dept-tech',
      instructions: 'Use your tools.',
      tools: ['slack', 'notion', 'not-a-real-tool'],
    });
    let toolCount = -1;
    const capturing: LlmProvider = {
      name: 'cap',
      async chat(req) {
        toolCount = req.tools?.length ?? 0;
        return { text: 'ok', toolCalls: [] };
      },
    };
    const rt = buildCustomRuntimeAgent(cfg, capturing);
    const specs = rt.chatTools!();
    expect(specs.map((s) => s.name)).toEqual(expect.arrayContaining(['readSlackMessages', 'readNotionPages']));
    expect(specs).toHaveLength(2); // the unknown slug is dropped at runtime
    await rt.run();
    expect(toolCount).toBe(2); // the wired tools were passed to the model
  });

  test('an agent with no tools passes none to the model', async () => {
    db = openDb(':memory:');
    const cfg = createCustomAgent(db, { name: 'Talker', departmentId: 'dept-tech', instructions: 'just talk' });
    let toolsField: unknown = 'unset';
    const capturing: LlmProvider = {
      name: 'cap',
      async chat(req) {
        toolsField = req.tools;
        return { text: 'ok', toolCalls: [] };
      },
    };
    await buildCustomRuntimeAgent(cfg, capturing).run();
    expect(toolsField).toBeUndefined();
  });
});

describe('custom agent API', () => {
  beforeAll(() => {
    process.env.FOUNDER_OS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'igris-custom-api-')), 'test.db');
    process.env.LLM_PROVIDER = 'stub';
  });

  test('POST creates, GET lists, PATCH edits, run executes, DELETE removes', async () => {
    const collection = await import('@/app/api/agents/route');
    const single = await import('@/app/api/agents/[id]/route');
    const runRoute = await import('@/app/api/agents/[id]/run/route');

    // create
    const created = await collection.POST(
      new Request('http://x/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: 'Outreach', departmentId: 'dept-sales', instructions: 'Draft cold outreach.' }),
      }),
    );
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as { agent: { id: string } };
    expect(agent.id).toMatch(/^custom-/);

    // list includes it under customAgents
    const listed = await (await collection.GET()).json();
    expect(listed.customAgents.some((a: { id: string }) => a.id === agent.id)).toBe(true);

    // run it — the stub LLM keeps this offline and deterministic
    const ran = await runRoute.POST(new Request('http://x'), { params: { id: agent.id } });
    const runBody = (await ran.json()) as { run: { ok: boolean; summary: string } };
    expect(runBody.run.ok).toBe(true);
    expect(runBody.run.summary).toContain('stub-reply');

    // patch it
    const patched = await single.PATCH(
      new Request('http://x', { method: 'PATCH', body: JSON.stringify({ name: 'Outreach v2' }) }),
      { params: { id: agent.id } },
    );
    expect((await patched.json()).agent.name).toBe('Outreach v2');

    // a built-in id is immutable → 404
    const forbidden = await single.PATCH(
      new Request('http://x', { method: 'PATCH', body: JSON.stringify({ name: 'hax' }) }),
      { params: { id: 'conductor' } },
    );
    expect(forbidden.status).toBe(404);

    // delete it
    const removed = single.DELETE(new Request('http://x'), { params: { id: agent.id } });
    expect((await removed.json()).ok).toBe(true);
    const after = await (await collection.GET()).json();
    expect(after.customAgents.some((a: { id: string }) => a.id === agent.id)).toBe(false);
  });

  test('POST rejects an invalid payload with 400', async () => {
    const collection = await import('@/app/api/agents/route');
    const res = await collection.POST(
      new Request('http://x/api/agents', { method: 'POST', body: JSON.stringify({ name: '' }) }),
    );
    expect(res.status).toBe(400);
  });
});
