/**
 * Architecture V2 · F0.1 — Capability persistence + Company Registry service.
 *
 * Verifies the additive tables (idempotent schema + assignment), that
 * capabilities attach to BOTH built-in and custom agents by canonical id,
 * the registry resolver over real repos, and that resolver output leaks no
 * prompts/tools/secrets. Existing registry behavior stays intact.
 */
import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '@/lib/db';
import { createCustomAgent } from '@/lib/agents/custom';
import {
  allRuntimeAgents,
  getAgentById,
  getCapabilitiesForAgent,
  getAgentsForCapability,
  resolveAgentsForCapabilities,
} from '@/lib/agents/registry';

const builtinId = (db: ReturnType<typeof openDb>) => allRuntimeAgents(db)[0].id;

function seedAgentsAndCaps(db: ReturnType<typeof openDb>) {
  db.capabilities.upsert({ id: 'research.market', name: 'Web Research' });
  db.capabilities.upsert({ id: 'research.market', name: 'Market Research' });
  const custom = createCustomAgent(db, { name: 'Scout', departmentId: 'dept-comms', instructions: 'Research things.', model: '', tools: [], enabled: true });
  return { builtin: builtinId(db), custom: custom.id };
}

describe('capabilities repo', () => {
  test('upsert is idempotent and preserves created_at; malformed rejected', () => {
    const db = openDb(':memory:');
    const first = db.capabilities.upsert({ id: 'Email.Read', name: 'Read Email' });
    expect(first.id).toBe('email.read'); // normalized
    expect(first.domain).toBe('email'); // defaulted from id
    const again = db.capabilities.upsert({ id: 'email.read', name: 'Read Email v2' });
    expect(db.capabilities.all()).toHaveLength(1); // one row
    expect(again.createdAt).toBe(first.createdAt); // created_at preserved
    expect(again.name).toBe('Read Email v2');
    expect(() => db.capabilities.upsert({ id: 'nodot', name: 'x' })).toThrow();
  });
});

describe('agent_capabilities: built-in AND custom agents', () => {
  test('assign to both kinds, idempotent, forAgent/forCapability, remove', () => {
    const db = openDb(':memory:');
    const { builtin, custom } = seedAgentsAndCaps(db);

    db.agentCapabilities.assign(builtin, { capabilityId: 'research.market', proficiency: 70 });
    db.agentCapabilities.assign(custom, { capabilityId: 'research.market' });
    // re-assign (idempotent): updates in place, no duplicate row
    const re = db.agentCapabilities.assign(builtin, { capabilityId: 'research.market', proficiency: 90 });
    expect(re.proficiency).toBe(90);
    expect(db.agentCapabilities.forAgent(builtin)).toHaveLength(1);

    expect(getCapabilitiesForAgent(db, custom).map((c) => c.id)).toEqual(['research.market']);
    expect(getAgentsForCapability(db, 'research.market').map((a) => a.agentId).sort()).toEqual([builtin, custom].sort());

    db.agentCapabilities.remove(custom, 'research.market');
    expect(db.agentCapabilities.forAgent(custom)).toHaveLength(0);
    expect(getAgentsForCapability(db, 'research.market').map((a) => a.agentId)).toEqual([builtin]);
  });

  test('assignment to an unknown agent is ignored by the registry lookup (not guessed)', () => {
    const db = openDb(':memory:');
    db.capabilities.upsert({ id: 'research.market', name: 'Web Research' });
    db.agentCapabilities.assign('ghost-agent', { capabilityId: 'research.market' });
    expect(getAgentsForCapability(db, 'research.market')).toEqual([]); // ghost not in the roster
  });
});

describe('resolveAgentsForCapabilities', () => {
  test('all vs any, no-match, safe output only', () => {
    const db = openDb(':memory:');
    const { builtin, custom } = seedAgentsAndCaps(db);
    // Two DISTINCT model-only capabilities so `all` vs `any` differ (both no tool requirement).
    db.agentCapabilities.assign(builtin, { capabilityId: 'research.market' });
    db.agentCapabilities.assign(builtin, { capabilityId: 'data.analyze' });
    db.agentCapabilities.assign(custom, { capabilityId: 'research.market' });

    const all = resolveAgentsForCapabilities(db, ['research.market', 'data.analyze'], { mode: 'all' });
    expect(all.map((m) => m.agentId)).toEqual([builtin]); // only the fully-covered agent

    const any = resolveAgentsForCapabilities(db, ['research.market', 'data.analyze'], { mode: 'any' });
    expect(any.map((m) => m.agentId).sort()).toEqual([builtin, custom].sort());
    expect(any.find((m) => m.agentId === builtin)!.score).toBe(2); // coverage

    expect(resolveAgentsForCapabilities(db, ['legal.canada'])).toEqual([]); // no guess

    // No prompts/tools/secrets in the resolver output.
    const json = JSON.stringify(all);
    for (const banned of ['systemPrompt', 'instructions', 'tools', 'chatTools', 'token', 'apiKey', 'secret']) {
      expect(json).not.toContain(banned);
    }
  });
});

describe('schema is idempotent + existing data unaffected', () => {
  test('re-opening the same file DB re-runs DDL harmlessly and preserves rows', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'igris-caps-')), 'test.db');
    const db1 = openDb(file);
    db1.capabilities.upsert({ id: 'research.market', name: 'Web Research' });
    const agent = allRuntimeAgents(db1)[0].id;
    db1.agentCapabilities.assign(agent, { capabilityId: 'research.market', proficiency: 60 });

    // Second open runs `CREATE TABLE IF NOT EXISTS` again — no error, data intact.
    const db2 = openDb(file);
    expect(db2.capabilities.all().map((c) => c.id)).toContain('research.market');
    expect(db2.agentCapabilities.forAgent(agent).map((a) => a.capabilityId)).toEqual(['research.market']);
    // Existing registry behavior still works.
    expect(getAgentById(db2, agent)).toBeTruthy();
  });
});
