/**
 * Architecture V2 · F0.1 — Capability model + resolver (pure).
 *
 * Pins the capability-id rules (normalize + validate, malformed rejected), the
 * Zod input schemas, and the deterministic resolver (all/any, no-match, ranking
 * by coverage → explicit-over-derived → proficiency → stable tie-break) with NO
 * inference. Everything here runs without SQLite.
 */
import { describe, expect, test } from 'vitest';
import {
  isValidCapabilityId,
  normalizeCapabilityId,
  domainOf,
  CapabilityInputSchema,
  AgentCapabilityAssignSchema,
  resolveAgents,
  type AgentCapabilityLite,
  type ResolverAgentRef,
} from '@/lib/agents/capabilities';

describe('capability id rules', () => {
  test('valid domain.action ids', () => {
    for (const id of ['email.read', 'email.summarize', 'research.web', 'finance.analysis', 'code.review', 'email.draft-reply']) {
      expect(isValidCapabilityId(id)).toBe(true);
    }
  });
  test('malformed ids rejected', () => {
    for (const id of ['email', 'Email.Read', 'email..read', '.email', 'email.', 'email read', 'email.read!', '', 'a'.repeat(200)]) {
      expect(isValidCapabilityId(id)).toBe(false);
    }
  });
  test('normalize lowercases + trims (does not validate)', () => {
    expect(normalizeCapabilityId('  Email.Summarize ')).toBe('email.summarize');
  });
  test('domainOf returns the first segment', () => {
    expect(domainOf('research.web')).toBe('research');
  });
});

describe('CapabilityInputSchema', () => {
  test('normalizes id + defaults domain from id when omitted', () => {
    const c = CapabilityInputSchema.parse({ id: '  Research.Web ', name: 'Web Research' });
    expect(c.id).toBe('research.web');
    expect(c.name).toBe('Web Research');
  });
  test('rejects a malformed id', () => {
    expect(CapabilityInputSchema.safeParse({ id: 'notvalid', name: 'x' }).success).toBe(false);
  });
  test('rejects an empty name', () => {
    expect(CapabilityInputSchema.safeParse({ id: 'email.read', name: '' }).success).toBe(false);
  });
});

describe('AgentCapabilityAssignSchema', () => {
  test('defaults source to explicit; proficiency optional 0–100', () => {
    expect(AgentCapabilityAssignSchema.parse({ capabilityId: 'email.read' })).toMatchObject({ capabilityId: 'email.read', source: 'explicit' });
    expect(AgentCapabilityAssignSchema.parse({ capabilityId: 'email.read', proficiency: 80 }).proficiency).toBe(80);
  });
  test('rejects out-of-range proficiency and malformed id', () => {
    expect(AgentCapabilityAssignSchema.safeParse({ capabilityId: 'email.read', proficiency: 101 }).success).toBe(false);
    expect(AgentCapabilityAssignSchema.safeParse({ capabilityId: 'bad id' }).success).toBe(false);
  });
});

// ── Resolver ─────────────────────────────────────────────────────────────────

const agents: ResolverAgentRef[] = [
  { id: 'a', name: 'Alice' },
  { id: 'b', name: 'Bob' },
  { id: 'c', name: 'Carol' },
];
const A = (agentId: string, capabilityId: string, extra: Partial<AgentCapabilityLite> = {}): AgentCapabilityLite => ({ agentId, capabilityId, ...extra });

describe('resolveAgents', () => {
  test('one required capability → the agents that have it', () => {
    const out = resolveAgents({ agents, assignments: [A('a', 'research.web'), A('b', 'email.read')], required: ['research.web'] });
    expect(out.map((m) => m.agentId)).toEqual(['a']);
    expect(out[0].matchedCapabilities).toEqual(['research.web']);
    expect(out[0].missingCapabilities).toEqual([]);
  });

  test('mode=all requires EVERY capability', () => {
    const assignments = [A('a', 'research.web'), A('a', 'research.market'), A('b', 'research.web')];
    const out = resolveAgents({ agents, assignments, required: ['research.web', 'research.market'], mode: 'all' });
    expect(out.map((m) => m.agentId)).toEqual(['a']); // b lacks research.market
  });

  test('mode=any matches at least one', () => {
    const assignments = [A('a', 'research.web'), A('b', 'research.market')];
    const out = resolveAgents({ agents, assignments, required: ['research.web', 'research.market'], mode: 'any' });
    expect(out.map((m) => m.agentId).sort()).toEqual(['a', 'b']);
  });

  test('no matching agent → empty (never a guess)', () => {
    expect(resolveAgents({ agents, assignments: [A('a', 'research.web')], required: ['legal.canada'] })).toEqual([]);
  });

  test('empty required → empty', () => {
    expect(resolveAgents({ agents, assignments: [A('a', 'research.web')], required: [] })).toEqual([]);
  });

  test('normalizes required + assignment ids before matching', () => {
    const out = resolveAgents({ agents, assignments: [A('a', 'Research.Web')], required: [' RESEARCH.WEB '] });
    expect(out.map((m) => m.agentId)).toEqual(['a']);
  });

  test('ranks by coverage first (any mode)', () => {
    const assignments = [A('a', 'research.web'), A('b', 'research.web'), A('b', 'research.market')];
    const out = resolveAgents({ agents, assignments, required: ['research.web', 'research.market'], mode: 'any' });
    expect(out[0].agentId).toBe('b'); // 2 matched beats 1
  });

  test('explicit ranks above derived at equal coverage', () => {
    const assignments = [A('a', 'research.web', { source: 'derived' }), A('b', 'research.web', { source: 'explicit' })];
    const out = resolveAgents({ agents, assignments, required: ['research.web'] });
    expect(out[0].agentId).toBe('b');
  });

  test('higher proficiency ranks first; unrated uses the neutral baseline (50) for ranking, null in output', () => {
    // a=90, b=40, c=unrated → ranks as a(90) > c(neutral 50) > b(40).
    const assignments = [A('a', 'research.web', { proficiency: 90 }), A('b', 'research.web', { proficiency: 40 }), A('c', 'research.web')];
    const out = resolveAgents({ agents, assignments, required: ['research.web'] });
    expect(out.map((m) => m.agentId)).toEqual(['a', 'c', 'b']);
    expect(out[0].proficiency).toBe(90);
    expect(out.find((m) => m.agentId === 'c')!.proficiency).toBeNull(); // unrated → null, not a fabricated number
  });

  test('deterministic name/id tie-break when all else equal', () => {
    const assignments = [A('a', 'research.web'), A('b', 'research.web'), A('c', 'research.web')];
    const out = resolveAgents({ agents, assignments, required: ['research.web'] });
    expect(out.map((m) => m.name)).toEqual(['Alice', 'Bob', 'Carol']); // stable by name
  });

  test('output carries only safe metadata (no prompt/tool/secret fields)', () => {
    const out = resolveAgents({ agents, assignments: [A('a', 'research.web')], required: ['research.web'] });
    const keys = Object.keys(out[0]).sort();
    expect(keys).toEqual(['agentId', 'matchedCapabilities', 'missingCapabilities', 'name', 'proficiency', 'score'].sort());
  });
});
