/**
 * Tool-backed capability eligibility (Architecture V2 · capability ≠ tool).
 *
 * A capability LABEL alone (e.g. `research.web`) no longer implies real tool access.
 * An agent is eligible for a tool-backed capability only when it ALSO has the required,
 * wired tool. Covers the requirement model, the resolver, the factory policy, the
 * dispatch preflight, and the eligible-agents API — with `research.web` as the regression
 * case (no web/search tool is wired, so it stays an explicit TOOL GAP).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { openDb } from '@/lib/db';
import { createCustomAgent } from '@/lib/agents/custom';
import { agentToolSpecsFor, WIRED_TOOL_SLUGS } from '@/lib/agents/agent-tools';
import { createMission, createCompanyTask, getEligibleAgentsForTask, getTaskToolGaps, assignTask, CompanyError } from '@/lib/company/service';
import { resolveAgentsForCapabilities } from '@/lib/agents/registry';
import { dispatchTask } from '@/lib/company/manager/delegation';
import {
  toolRequirementFor,
  isToolBackedCapability,
  satisfiesToolRequirement,
  usableRequiredTools,
  toolGapReason,
  type CapabilityToolRequirement,
} from '@/lib/agents/capability-tools';
import { validateSpecAgainstPolicy, DEFAULT_FACTORY_POLICY, AgentSpecSchema } from '@/lib/company/factory/model';

type DB = ReturnType<typeof openDb>;

function agentWithCap(db: DB, name: string, cap: string, tools: string[] = []): string {
  const a = createCustomAgent(db, { name, departmentId: 'dept-tech', instructions: 'x', model: '', tools, enabled: true });
  db.capabilities.upsert({ id: cap, name: cap });
  db.agentCapabilities.assign(a.id, { capabilityId: cap });
  return a.id;
}

// ── Requirement model (pure) ──────────────────────────────────────────────────
describe('capability tool-requirement model', () => {
  it('model-only capabilities have NO tool requirement (behave as before)', () => {
    expect(toolRequirementFor('research.market')).toBeNull();
    expect(isToolBackedCapability('research.market')).toBe(false);
    expect(toolRequirementFor('analysis.summarize')).toBeNull();
  });

  it('research.web is tool-backed (requires a real web/search tool)', () => {
    const req = toolRequirementFor('research.web')!;
    expect(req).not.toBeNull();
    expect(req.mode).toBe('any');
    expect(req.requiredToolIds.length).toBeGreaterThan(0);
  });

  it('`any` is satisfied by one available required tool; missing tool → unsatisfied', () => {
    const req: CapabilityToolRequirement = { capabilityId: 'x.y', requiredToolIds: ['slack', 'gmail'], mode: 'any' };
    const available = new Set(['slack', 'gmail']);
    expect(satisfiesToolRequirement(req, ['slack'], available)).toBe(true);
    expect(satisfiesToolRequirement(req, [], available)).toBe(false); // no tool assigned
    expect(satisfiesToolRequirement(req, ['notion'], available)).toBe(false); // wrong tool
    // assigned but NOT available/wired → not usable
    expect(satisfiesToolRequirement(req, ['slack'], new Set(['gmail']))).toBe(false);
  });

  it('`all` requires every required tool to be usable', () => {
    const req: CapabilityToolRequirement = { capabilityId: 'x.y', requiredToolIds: ['slack', 'gmail'], mode: 'all' };
    const available = new Set(['slack', 'gmail']);
    expect(satisfiesToolRequirement(req, ['slack', 'gmail'], available)).toBe(true);
    expect(satisfiesToolRequirement(req, ['slack'], available)).toBe(false);
    expect(usableRequiredTools(req, ['slack'], available)).toEqual(['slack']);
  });

  it('research.web requires the real web.search tool — assigned AND wired', () => {
    const req = toolRequirementFor('research.web')!;
    expect(req.requiredToolIds).toEqual(['web.search']);
    // listing the slug is not enough if it is not wired/available in the given set
    expect(satisfiesToolRequirement(req, ['web.search'], new Set(['slack', 'gmail', 'gbrain']))).toBe(false);
    // assigned AND wired/available → satisfied
    expect(satisfiesToolRequirement(req, ['web.search'], new Set(['web.search']))).toBe(true);
    expect(toolGapReason(req)).toMatch(/research\.web requires a web\.search tool/);
  });

  it('web.search is a genuinely wired tool (exposed to agents that carry it)', () => {
    expect(WIRED_TOOL_SLUGS).toContain('web.search');
    const specs = agentToolSpecsFor(['web.search']);
    expect(specs.map((s) => s.name)).toContain('searchWeb');
  });
});

// ── Resolver ──────────────────────────────────────────────────────────────────
describe('resolver — tool-aware eligibility', () => {
  it('a capability label alone is INSUFFICIENT for a tool-backed capability', () => {
    const db = openDb(':memory:');
    agentWithCap(db, 'Fake Web Researcher', 'research.web', []); // label, but no web tool
    expect(resolveAgentsForCapabilities(db, ['research.web'], { mode: 'all' })).toHaveLength(0);
  });

  it('a capability + the REAL wired tool IS eligible (research.web now usable)', () => {
    const db = openDb(':memory:');
    const id = agentWithCap(db, 'Web Researcher', 'research.web', ['web.search']);
    const eligible = resolveAgentsForCapabilities(db, ['research.web'], { mode: 'all' });
    expect(eligible.map((m) => m.agentId)).toEqual([id]);
  });

  it('a model-only capability is eligible on the label alone (unchanged)', () => {
    const db = openDb(':memory:');
    const id = agentWithCap(db, 'Analyst', 'research.market', []);
    const eligible = resolveAgentsForCapabilities(db, ['research.market'], { mode: 'all' });
    expect(eligible.map((m) => m.agentId)).toEqual([id]);
  });

  it('enforceToolRequirements:false restores the capability-only view', () => {
    const db = openDb(':memory:');
    const id = agentWithCap(db, 'Fake Web Researcher', 'research.web', []);
    expect(resolveAgentsForCapabilities(db, ['research.web'], { mode: 'all' })).toHaveLength(0);
    const capOnly = resolveAgentsForCapabilities(db, ['research.web'], { mode: 'all', enforceToolRequirements: false });
    expect(capOnly.map((m) => m.agentId)).toEqual([id]);
  });
});

// ── Manual assignment ───────────────────────────────────────────────────────
describe('manual assignment respects tool requirements', () => {
  it('cannot assign a tool-less agent to a tool-backed task', () => {
    const db = openDb(':memory:');
    const agent = agentWithCap(db, 'Fake', 'research.web', []);
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'Collect Daily AI Updates', requiredCapabilities: ['research.web'] });
    expect(() => assignTask(db, t.id, agent)).toThrow(CompanyError); // 409: lacks the real tool
  });
});

// ── Factory ─────────────────────────────────────────────────────────────────
describe('factory — a tool-backed capability must carry its real tool', () => {
  it('a research.web spec that OMITS the web tool FAILS policy (no silent label-only agent)', () => {
    const spec = AgentSpecSchema.parse({ name: 'AI Updates Researcher', instructions: 'Research honestly.', tools: ['gbrain'], requiredCapabilities: ['research.web'] });
    const check = validateSpecAgainstPolicy(spec, DEFAULT_FACTORY_POLICY, 1);
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toMatch(/research\.web requires a tool this spec does not include/);
  });

  it('a research.web spec WITH the real web.search tool PASSES policy (factory can now tool-back it)', () => {
    const spec = AgentSpecSchema.parse({ name: 'AI Updates Researcher', instructions: 'Research honestly and cite sources.', tools: ['web.search'], requiredCapabilities: ['research.web'] });
    expect(validateSpecAgainstPolicy(spec, DEFAULT_FACTORY_POLICY, 1).ok).toBe(true);
  });

  it('a model-only capability spec passes policy (unchanged)', () => {
    const spec = AgentSpecSchema.parse({ name: 'Market Analyst', instructions: 'Analyze supplied material.', tools: ['gbrain'], requiredCapabilities: ['research.market'] });
    expect(validateSpecAgainstPolicy(spec, DEFAULT_FACTORY_POLICY, 1).ok).toBe(true);
  });
});

// ── Dispatch preflight ────────────────────────────────────────────────────────
describe('dispatch preflight — never start an agent that lacks the required tool', () => {
  beforeAll(() => {
    process.env.LLM_PROVIDER = 'stub'; // the tool-eligible agent actually runs (deterministic, offline)
  });

  it('an agent WITH the real web.search tool passes preflight — starts and completes', async () => {
    const db = openDb(':memory:');
    const agent = agentWithCap(db, 'Web Researcher', 'research.web', ['web.search']);
    const m = createMission(db, { title: 'TOP AI UPDATE DAILY BRIEF' });
    const t = createCompanyTask(db, m.id, { title: 'Collect Daily AI Updates', requiredCapabilities: ['research.web'] });

    const res = await dispatchTask(db, t.id);
    expect(res.outcome).toBe('dispatched_agent');

    const events = db.companyEvents.forTask(t.id, 100).map((e) => e.type);
    expect(events).toContain('AGENT_STARTED');
    expect(events).not.toContain('CAPABILITY_GAP');
    expect(db.agentRuns.byAgent(agent).length).toBe(1);
    expect(db.companyTasks.get(t.id)!.status).toBe('completed');
  });

  it('a stale-assigned tool-less agent is NOT started; task stays queued; explicit tool gap', async () => {
    const db = openDb(':memory:');
    const agent = agentWithCap(db, 'Fake Web Researcher', 'research.web', []);
    const m = createMission(db, { title: 'TOP AI UPDATE DAILY BRIEF' });
    const t = createCompanyTask(db, m.id, { title: 'Collect Daily AI Updates', requiredCapabilities: ['research.web'] });
    // Simulate a pre-fix / stale direct assignment (bypassing the now-guarded assignTask).
    const row = db.companyTasks.get(t.id)!;
    db.companyTasks.insert({ ...row, assignedAgentId: agent, status: 'assigned' });

    const res = await dispatchTask(db, t.id);
    expect(res.outcome).toBe('capability_gap');
    if (res.outcome === 'capability_gap') expect(res.toolGap).toContain('research.web');

    // No agent run was spent; no AGENT_STARTED; the task is NOT failed — it stays queued/assigned.
    expect(db.agentRuns.byAgent(agent).length).toBe(0);
    const events = db.companyEvents.forTask(t.id, 100).map((e) => e.type);
    expect(events).not.toContain('AGENT_STARTED');
    expect(events).toContain('CAPABILITY_GAP');
    expect(db.companyTasks.get(t.id)!.status).not.toBe('failed');
    expect(db.companyTasks.get(t.id)!.status).not.toBe('running');
  });
});

// ── Eligible-agents API (service) ────────────────────────────────────────────
describe('eligible-agents surfaces the tool gap safely', () => {
  it('empty eligible list + an explicit, secret-free tool-gap reason', () => {
    const db = openDb(':memory:');
    agentWithCap(db, 'Fake Web Researcher', 'research.web', []);
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'Collect Daily AI Updates', requiredCapabilities: ['research.web'] });
    expect(getEligibleAgentsForTask(db, t.id)).toHaveLength(0);
    const gaps = getTaskToolGaps(db, t.id);
    expect(gaps.map((g) => g.capabilityId)).toContain('research.web');
    const json = JSON.stringify(gaps);
    expect(json).not.toMatch(/API_KEY|SECRET|token|password/i); // no connector config leaks
  });

  it('a model-only task has no tool gaps', () => {
    const db = openDb(':memory:');
    agentWithCap(db, 'Analyst', 'research.market', []);
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'Analyze', requiredCapabilities: ['research.market'] });
    expect(getTaskToolGaps(db, t.id)).toHaveLength(0);
    expect(getEligibleAgentsForTask(db, t.id).length).toBe(1);
  });
});
