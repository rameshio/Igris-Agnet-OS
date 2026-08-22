/**
 * IGRIS CLI — argument parsing, HTTP-only client behavior, output/JSON, exit codes,
 * mutation confirmation (+ --yes), approval authority routing, server-unavailable, and
 * secret redaction. All tests use an INJECTED fetch (no live server, no subprocess, no
 * DB) — proving the CLI is a pure control surface over the canonical API.
 */
import { describe, it, expect, vi } from 'vitest';
import { run, runCaptured, parseArgv } from '@/lib/cli/router';
import type { FetchLike } from '@/lib/cli/client';
import { EXIT } from '@/lib/cli/exit';

type Handler = { status: number; data: unknown } | ((body: unknown) => { status: number; data: unknown });

/** Build an injectable fetch from a `METHOD /path` route table (path without query). */
function mockFetch(routes: Record<string, Handler>, seen?: string[]): FetchLike {
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toString().toUpperCase();
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const key = `${method} ${path}`;
    seen?.push(key);
    const h = routes[key];
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const resolved = typeof h === 'function' ? h(body) : h ?? { status: 404, data: { error: `no route ${key}` } };
    return { status: resolved.status, json: async () => resolved.data, text: async () => JSON.stringify(resolved.data) };
  };
}

const alwaysYes = async () => true;
const alwaysNo = async () => false;

describe('argv parsing', () => {
  it('splits group, args, and typed flags', () => {
    const p = parseArgv(['mission', 'create', 'My Title', '--objective', 'Do it', '--yes', '--json']);
    expect(p.group).toBe('mission');
    expect(p.args).toEqual(['create', 'My Title']);
    expect(p.flags.objective).toBe('Do it');
    expect(p.flags.yes).toBe(true);
    expect(p.flags.json).toBe(true);
  });
});

describe('help + unknown', () => {
  it('prints help and exits 0', async () => {
    const r = await runCaptured(['--help']);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toContain('IGRIS');
  });
  it('unknown command → invalid input', async () => {
    const r = await runCaptured(['frobnicate']);
    expect(r.code).toBe(EXIT.INVALID_INPUT);
    expect(r.stderr).toMatch(/unknown command/);
  });
});

describe('server unavailable', () => {
  it('maps a network failure to exit 3 (never touches the DB)', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const r = await runCaptured(['status'], { fetchImpl });
    expect(r.code).toBe(EXIT.SERVER_UNAVAILABLE);
    expect(r.stderr).toMatch(/not reachable/);
  });
});

describe('read commands', () => {
  it('status --json returns a safe summary', async () => {
    const fetchImpl = mockFetch({
      'GET /api/models/providers': { status: 200, data: { providers: [{ id: 'openai', configured: true }], brain: { available: false, activeBrain: 'gateway' }, default: { model: 'openai:gpt-4o', strategy: 'fixed' } } },
      'GET /api/missions': { status: 200, data: { missions: [{ status: 'active' }, { status: 'completed' }] } },
      'GET /api/flow-approvals': { status: 200, data: { approvals: [] } },
    });
    const r = await runCaptured(['status', '--json'], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    const out = JSON.parse(r.stdout);
    expect(out.activeMissions).toBe(1);
    expect(out.providersConfigured).toBe('1/1');
  });

  it('models providers renders a table with capabilities', async () => {
    const fetchImpl = mockFetch({
      'GET /api/models/providers': { status: 200, data: { providers: [{ id: 'anthropic', name: 'Anthropic', configured: true, connected: false, enabled: true, capabilities: ['text', 'tool_calling'], models: ['claude-opus-4'] }], brain: { name: 'Hermes', available: true, activeBrain: 'hermes', capabilities: ['text'] }, default: { model: '', strategy: 'hermes' } } },
    });
    const r = await runCaptured(['models', 'providers'], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toMatch(/anthropic/);
    expect(r.stdout).toMatch(/tool_calling/);
    expect(r.stdout).toMatch(/hermes/);
  });

  it('task eligible shows agents + tool gaps', async () => {
    const fetchImpl = mockFetch({
      'GET /api/company-tasks/t1/eligible-agents': { status: 200, data: { agents: [], toolGaps: [{ capabilityId: 'research.web', reason: 'research.web requires a web.search tool, but no eligible tool is available' }] } },
    });
    const r = await runCaptured(['task', 'eligible', 't1'], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toMatch(/none eligible/);
    expect(r.stdout).toMatch(/web\.search/);
  });

  it('intelligence --window 7d lists signals', async () => {
    const fetchImpl = mockFetch({
      'GET /api/company/intelligence': { status: 200, data: { generatedAt: 'now', window: { key: '7d' }, signals: [{ severity: 'critical', title: 'Capability gap', summary: 'No agent can satisfy X' }] } },
    });
    const r = await runCaptured(['intelligence', '--window', '7d'], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toMatch(/critical/);
  });

  it('ask returns the model answer read-only', async () => {
    const seen: string[] = [];
    const fetchImpl = mockFetch({ 'POST /api/conductor/ask': { status: 200, data: { answer: 'Nothing is blocking.', model: 'openai:gpt-4o', adapter: 'openai-compatible' } } }, seen);
    const r = await runCaptured(['ask', 'what is blocking?'], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toMatch(/Nothing is blocking/);
    expect(seen).toContain('POST /api/conductor/ask');
  });
});

describe('mutations require confirmation', () => {
  it('mission create without a title → invalid input', async () => {
    const r = await runCaptured(['mission', 'create'], { fetchImpl: mockFetch({}) });
    expect(r.code).toBe(EXIT.INVALID_INPUT);
  });

  it('mission create is NOT sent when confirmation is denied', async () => {
    const seen: string[] = [];
    const fetchImpl = mockFetch({ 'POST /api/missions': { status: 200, data: { mission: { id: 'm1', title: 'X' } } } }, seen);
    const r = await runCaptured(['mission', 'create', 'X'], { fetchImpl, confirm: alwaysNo });
    expect(r.code).toBe(EXIT.ACTION_NOT_COMPLETED);
    expect(seen).not.toContain('POST /api/missions'); // no mutation performed
  });

  it('mission create with --yes sends the request', async () => {
    const seen: string[] = [];
    const fetchImpl = mockFetch({ 'POST /api/missions': { status: 200, data: { mission: { id: 'm1', title: 'X' } } } }, seen);
    const r = await runCaptured(['mission', 'create', 'X', '--yes'], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(seen).toContain('POST /api/missions');
    expect(r.stdout).toMatch(/created mission m1/);
  });

  it('approval approve routes through the backend-authoritative endpoint (with --yes)', async () => {
    const seen: string[] = [];
    const fetchImpl = mockFetch({
      'GET /api/flow-approvals/a1': { status: 200, data: { approval: { id: 'a1', runId: 'run1', title: 'Send email' } } },
      'POST /api/flow-approvals/a1/approve': { status: 200, data: { ok: true } },
    }, seen);
    const r = await runCaptured(['approval', 'approve', 'a1', '--yes'], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(seen).toContain('POST /api/flow-approvals/a1/approve');
  });

  it('task dispatch surfaces a capability/tool gap as not-completed', async () => {
    const fetchImpl = mockFetch({
      'GET /api/company-tasks/t1/eligible-agents': { status: 200, data: { agents: [], toolGaps: [{ capabilityId: 'research.web', reason: 'needs web.search' }] } },
      'POST /api/company-tasks/t1/dispatch': { status: 200, data: { outcome: 'capability_gap', toolGap: ['research.web'] } },
    });
    const r = await runCaptured(['task', 'dispatch', 't1', '--yes'], { fetchImpl });
    expect(r.code).toBe(EXIT.ACTION_NOT_COMPLETED);
    expect(r.stdout).toMatch(/capability_gap/);
  });
});

describe('secret redaction', () => {
  it('never prints an API-key-looking value from a response', async () => {
    const leak = 'sk-ant-abcdefghijklmnopqrstuvwxyz012345';
    const fetchImpl = mockFetch({
      'GET /api/company-artifacts/art1': { status: 200, data: { artifact: { title: 'Result', type: 'agent_result', content: `key is ${leak} in here` } } },
    });
    const r = await runCaptured(['artifact', 'show', 'art1'], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).not.toContain(leak);
    expect(r.stdout).toMatch(/\[redacted\]/);
  });
});

describe('canonicalRef formatting + missing-source handling', () => {
  it('brain entity renders canonicalRef as kind:id (never [object Object]) + missing note', async () => {
    const fetchImpl = mockFetch({
      'GET /api/brain/entities/bent-1': { status: 200, data: { entity: { id: 'bent-1', type: 'artifact', name: 'Define Top AI Scope — result', canonicalRef: { kind: 'artifact', id: 'artifact-fe59' } }, canonicalState: 'missing' } },
    });
    const r = await runCaptured(['brain', 'entity', 'bent-1'], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toContain('artifact:artifact-fe59');
    expect(r.stdout).not.toContain('[object Object]');
    expect(r.stdout).toMatch(/canonicalState/);
    expect(r.stdout).toMatch(/no longer exists/);
  });

  it('brain entity --json keeps canonicalRef structured', async () => {
    const fetchImpl = mockFetch({
      'GET /api/brain/entities/bent-1': { status: 200, data: { entity: { id: 'bent-1', canonicalRef: { kind: 'artifact', id: 'artifact-fe59' } }, canonicalState: 'missing' } },
    });
    const r = await runCaptured(['brain', 'entity', 'bent-1', '--json'], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    const out = JSON.parse(r.stdout);
    expect(out.entity.canonicalRef).toEqual({ kind: 'artifact', id: 'artifact-fe59' });
  });

  it('brain neighborhood renders neighbor names for provenance edges', async () => {
    const fetchImpl = mockFetch({
      'GET /api/brain/entities/bent-1/relationships': { status: 200, data: { entity: { id: 'bent-1', name: 'Artifact' }, relationships: [{ type: 'PRODUCED', fromEntityId: 'bent-agent', toEntityId: 'bent-1' }], neighbors: [{ id: 'bent-agent', name: 'AI Scope Analyst' }] } },
    });
    const r = await runCaptured(['brain', 'neighborhood', 'bent-1'], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toMatch(/PRODUCED/);
    expect(r.stdout).toContain('AI Scope Analyst');
    expect(r.stdout).toContain('Artifact');
  });

  it('artifact show for a deleted id fails clearly and points to brain search', async () => {
    const fetchImpl = mockFetch({ 'GET /api/company-artifacts/artifact-fe59': { status: 404, data: { error: 'artifact not found' } } });
    const r = await runCaptured(['artifact', 'show', 'artifact-fe59'], { fetchImpl });
    expect(r.code).toBe(EXIT.INVALID_INPUT); // non-zero
    expect(r.stderr).toMatch(/Company Core/);
    expect(r.stderr).toMatch(/brain search/);
  });
});
