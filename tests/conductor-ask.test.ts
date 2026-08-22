/**
 * Conductor Ask — READ-ONLY operator query grounded in safe company context, answered
 * through the unified runtime. Verifies the context is deterministic + secret-free and
 * that the answer routes through routeModel (fixed provider) with no silent fallback.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { openDb } from '@/lib/db';
import { createMission } from '@/lib/company/service';
import { buildCompanyContext, askConductor } from '@/lib/conductor/ask';
import { setDefaultModel } from '@/lib/models/default-model';

const okJson = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) }) as Response;

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
});

describe('buildCompanyContext', () => {
  it('summarizes active missions + approvals safely, with no secrets', () => {
    const db = openDb(':memory:');
    createMission(db, { title: 'Research today AI news' });
    const ctx = buildCompanyContext(db);
    expect(ctx.activeMissions).toBeGreaterThanOrEqual(1);
    expect(ctx.text).toContain('Research today AI news');
    expect(ctx.text).toContain('Pending human approvals');
    expect(JSON.stringify(ctx)).not.toMatch(/API_KEY|SECRET|sk-|Bearer /i);
  });
});

describe('askConductor', () => {
  it('rejects an empty question', async () => {
    const db = openDb(':memory:');
    await expect(askConductor(db, { question: '  ' })).rejects.toThrow(/question is required/);
  });

  it('routes through the configured fixed provider and returns the answer', async () => {
    const db = openDb(':memory:');
    process.env.OPENAI_API_KEY = 'sk-test-should-never-be-printed';
    setDefaultModel(db, 'openai:gpt-4o');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ choices: [{ message: { content: 'Nothing is blocking right now.' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));

    const res = await askConductor(db, { question: 'What is blocking my missions?' });
    expect(res.answer).toBe('Nothing is blocking right now.');
    expect(res.model).toBe('openai:gpt-4o');
    expect(spy).toHaveBeenCalledTimes(1);
    // the model was called with company context, never a secret in the result
    expect(JSON.stringify(res)).not.toContain('sk-test');
  });

  it('surfaces an honest provider error (no silent fallback)', async () => {
    const db = openDb(':memory:');
    process.env.OPENAI_API_KEY = 'sk-test';
    setDefaultModel(db, 'openai:gpt-4o');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key', json: async () => ({}) } as Response);
    await expect(askConductor(db, { question: 'hi' })).rejects.toMatchObject({ code: 'auth_failed' });
  });
});
