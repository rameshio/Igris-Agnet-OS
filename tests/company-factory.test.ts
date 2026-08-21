/**
 * Agent Factory — pure model tests (Architecture V2 · F2).
 *
 * The policy, the spec schema, the policy validator, and the safe projection are
 * pure (no DB/LLM), so the SERVER-owned safety invariants are proven here without
 * SQLite: a proposed agent may carry only allow-listed tools (bounded), an allowed
 * model, bounded instructions, and a bounded creation depth — anything else fails safe.
 */
import { describe, it, expect } from 'vitest';
import {
  AgentSpecSchema,
  DEFAULT_FACTORY_POLICY,
  FACTORY_MAX_INSTRUCTIONS_CEILING,
  resolvePolicy,
  validateSpecAgainstPolicy,
  safeProposalSummary,
  type AgentProposal,
  type AgentSpec,
} from '@/lib/company/factory/model';

const baseSpec = (over: Partial<AgentSpec> = {}): AgentSpec =>
  AgentSpecSchema.parse({
    name: 'Gap Filler',
    instructions: 'Do the thing honestly.',
    requiredCapabilities: ['research.market'],
    ...over,
  });

describe('AgentSpecSchema', () => {
  it('normalizes capability ids and defaults optional fields', () => {
    const spec = AgentSpecSchema.parse({
      name: '  Researcher  ',
      instructions: 'Research things.',
      requiredCapabilities: ['Research.Market', 'data.enrich'],
    });
    expect(spec.name).toBe('Researcher'); // trimmed
    expect(spec.requiredCapabilities).toEqual(['research.market', 'data.enrich']); // lowercased
    expect(spec.tools).toEqual([]);
    expect(spec.model).toBe('');
    expect(spec.description).toBe('');
  });

  it('rejects a spec with no required capabilities', () => {
    expect(() => AgentSpecSchema.parse({ name: 'X', instructions: 'y', requiredCapabilities: [] })).toThrow();
  });

  it('rejects an invalid capability id', () => {
    expect(() =>
      AgentSpecSchema.parse({ name: 'X', instructions: 'y', requiredCapabilities: ['NotACapability'] }),
    ).toThrow();
  });
});

describe('resolvePolicy', () => {
  it('returns the default when no override is given', () => {
    expect(resolvePolicy()).toEqual(DEFAULT_FACTORY_POLICY);
    expect(resolvePolicy(null)).toEqual(DEFAULT_FACTORY_POLICY);
  });

  it('applies a bounded override (stricter only)', () => {
    const p = resolvePolicy({ maxTools: 2, allowedTools: ['slack'] });
    expect(p.maxTools).toBe(2);
    expect(p.allowedTools).toEqual(['slack']);
    expect(p.canSpawn).toBe(false); // untouched invariant
  });

  it('rejects an override that exceeds a ceiling', () => {
    expect(() => resolvePolicy({ maxTools: 999 })).toThrow();
  });

  it('rejects an override granting a tool off the allow-list', () => {
    expect(() => resolvePolicy({ allowedTools: ['rm-rf' as never] })).toThrow();
  });
});

describe('validateSpecAgainstPolicy', () => {
  const policy = DEFAULT_FACTORY_POLICY;

  it('accepts a spec within policy', () => {
    const res = validateSpecAgainstPolicy(baseSpec({ tools: ['slack', 'gmail'] }), policy, 1);
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
  });

  it('rejects tools off the allow-list', () => {
    const spec = baseSpec({ tools: ['slack', 'shell'] });
    const res = validateSpecAgainstPolicy(spec, policy, 1);
    expect(res.ok).toBe(false);
    expect(res.violations.join(' ')).toMatch(/allow-list/);
  });

  it('rejects too many tools', () => {
    const res = validateSpecAgainstPolicy(baseSpec({ tools: ['slack', 'gmail'] }), { ...policy, maxTools: 1 }, 1);
    expect(res.ok).toBe(false);
    expect(res.violations.join(' ')).toMatch(/too many tools/);
  });

  it('rejects a model off the allow-list', () => {
    const res = validateSpecAgainstPolicy(baseSpec({ model: 'openai/gpt-4' }), policy, 1);
    expect(res.ok).toBe(false);
    expect(res.violations.join(' ')).toMatch(/model not allowed/);
  });

  it('rejects creation depth beyond maxDepth', () => {
    const res = validateSpecAgainstPolicy(baseSpec(), policy, 2);
    expect(res.ok).toBe(false);
    expect(res.violations.join(' ')).toMatch(/maxDepth/);
  });

  it('rejects over-length instructions', () => {
    const res = validateSpecAgainstPolicy(
      { ...baseSpec(), instructions: 'x'.repeat(FACTORY_MAX_INSTRUCTIONS_CEILING + 1) },
      policy,
      1,
    );
    expect(res.ok).toBe(false);
    expect(res.violations.join(' ')).toMatch(/instructions exceed/);
  });
});

describe('safeProposalSummary', () => {
  it('exposes identifiers + labels only — never the instructions or policy internals', () => {
    const spec = baseSpec({ tools: ['slack'], instructions: 'SECRET SYSTEM PROMPT' });
    const proposal: AgentProposal = {
      id: 'prop-1',
      missionId: 'm-1',
      taskId: 't-1',
      status: 'pending',
      spec,
      policy: DEFAULT_FACTORY_POLICY,
      requiredCapabilities: ['research.market'],
      rationale: 'fills the gap',
      temporary: true,
      maxDepth: 1,
      budgetUsd: 5,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const s = safeProposalSummary(proposal);
    expect(s.agentName).toBe('Gap Filler');
    expect(s.tools).toEqual(['slack']);
    expect(s.requiredCapabilities).toEqual(['research.market']);
    // The prompt must not leak through the safe projection.
    expect(JSON.stringify(s)).not.toMatch(/SECRET SYSTEM PROMPT/);
    expect(JSON.stringify(s)).not.toMatch(/allowedTools/);
  });
});
