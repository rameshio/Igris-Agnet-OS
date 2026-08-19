/**
 * Agent Factory service tests (Architecture V2 · F2) — over the real repos.
 *
 * Proves the human-gated loop end to end: a real gap is proposed (no agent created),
 * policy violations fail safe, promotion CREATES the agent + assigns exactly the gap
 * capabilities (so the F1 resolver now matches and the task dispatches), reject creates
 * nothing, both decisions are idempotent, and a completed mission retires its temporary
 * factory agent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';
import { createCustomAgent } from '@/lib/agents/custom';
import { resolveAgentsForCapabilities } from '@/lib/agents/registry';
import { createMission, createCompanyTask, getCompanyTask, updateMission } from '@/lib/company/service';
import { managerStep } from '@/lib/company/manager/service';
import { dispatchTask } from '@/lib/company/manager/delegation';
import {
  proposeAgentForGap,
  promoteProposal,
  rejectProposal,
  retireTemporaryAgents,
  type Proposer,
} from '@/lib/company/factory/service';

const prevLlm = process.env.LLM_PROVIDER;
beforeAll(() => {
  process.env.LLM_PROVIDER = 'stub'; // custom-agent runs resolve deterministically (ok: true)
});
afterAll(() => {
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
});

type DB = ReturnType<typeof openDb>;

/** A deterministic proposer that returns a spec (as fenced JSON), no live model needed. */
const proposerFor = (spec: Record<string, unknown>): Proposer => async () => '```json\n' + JSON.stringify(spec) + '\n```';

const validSpec = {
  name: 'Web Scout',
  description: 'Researches on the web.',
  instructions: 'Research the topic and report findings honestly.',
  model: '',
  tools: ['gbrain'],
  requiredCapabilities: ['research.web'],
  rationale: 'No existing agent can research the web.',
};

function missionWithGapTask(db: DB, cap = 'research.web') {
  const m = createMission(db, { title: 'Market study' });
  const task = createCompanyTask(db, m.id, { title: 'Analyze the market', requiredCapabilities: [cap] });
  return { missionId: m.id, taskId: task.id };
}

describe('proposeAgentForGap', () => {
  test('stores a PENDING proposal and creates NO agent / NO capability yet', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithGapTask(db);
    const agentsBefore = db.customAgents.all().length;

    const proposal = await proposeAgentForGap(db, taskId, { proposer: proposerFor(validSpec) });

    expect(proposal.status).toBe('pending');
    expect(proposal.agentId).toBeUndefined();
    expect(proposal.requiredCapabilities).toEqual(['research.web']); // server-owned = the gap
    expect(db.customAgents.all().length).toBe(agentsBefore); // nothing created
    expect(db.agentCapabilities.all()).toHaveLength(0); // nothing assigned
    expect(db.companyAgentProposals.forMission(missionId).map((p) => p.status)).toEqual(['pending']);
    expect(db.companyEvents.forMission(missionId).map((e) => e.type)).toContain('AGENT_PROPOSED');
  });

  test('refuses a task that is not a real gap (an eligible agent already exists)', async () => {
    const db = openDb(':memory:');
    // An existing agent already covers the capability.
    const a = createCustomAgent(db, { name: 'Existing', departmentId: 'dept-tech', instructions: 'x', model: '', tools: [], enabled: true });
    db.capabilities.upsert({ id: 'research.web', name: 'research.web' });
    db.agentCapabilities.assign(a.id, { capabilityId: 'research.web' });
    const { taskId } = missionWithGapTask(db);

    await expect(proposeAgentForGap(db, taskId, { proposer: proposerFor(validSpec) })).rejects.toMatchObject({ status: 409 });
    expect(db.companyAgentProposals.all()).toHaveLength(0);
  });

  test('a spec violating policy fails safe (400) — nothing persisted', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithGapTask(db);

    const badTools = proposerFor({ ...validSpec, tools: ['shell'] }); // off the allow-list
    await expect(proposeAgentForGap(db, taskId, { proposer: badTools })).rejects.toMatchObject({ status: 400 });

    const badModel = proposerFor({ ...validSpec, model: 'openai/gpt-4' }); // not allowed
    await expect(proposeAgentForGap(db, taskId, { proposer: badModel })).rejects.toMatchObject({ status: 400 });

    expect(db.companyAgentProposals.forMission(missionId)).toHaveLength(0);
    expect(db.customAgents.all()).toHaveLength(0);
  });
});

describe('promoteProposal', () => {
  test('creates an enabled agent, assigns the gap caps, and the F1 resolver now matches', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithGapTask(db);
    expect(resolveAgentsForCapabilities(db, ['research.web'], { mode: 'all' })).toHaveLength(0); // gap

    const proposal = await proposeAgentForGap(db, taskId, { proposer: proposerFor(validSpec) });
    const { agentId, created } = promoteProposal(db, proposal.id);

    expect(created).toBe(true);
    const agent = db.customAgents.get(agentId)!;
    expect(agent.enabled).toBe(true);
    expect(agent.name).toBe('Web Scout');
    expect(agent.tools).toEqual(['gbrain']);
    // Resolver now matches the freshly created agent.
    const eligible = resolveAgentsForCapabilities(db, ['research.web'], { mode: 'all' });
    expect(eligible.map((e) => e.agentId)).toContain(agentId);

    // The gap task now dispatches to the new agent (existing runtime; stub provider).
    const r = await dispatchTask(db, taskId);
    expect(r.outcome).toBe('dispatched_agent');
    if (r.outcome === 'dispatched_agent') expect(getCompanyTask(db, taskId)!.assignedAgentId).toBe(agentId);
  });

  test('is idempotent — a double approve promotes exactly one agent', async () => {
    const db = openDb(':memory:');
    const { taskId } = missionWithGapTask(db);
    const proposal = await proposeAgentForGap(db, taskId, { proposer: proposerFor(validSpec) });

    const first = promoteProposal(db, proposal.id);
    const second = promoteProposal(db, proposal.id);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.agentId).toBe(first.agentId);
    expect(db.customAgents.all()).toHaveLength(1);
  });
});

describe('rejectProposal', () => {
  test('rejects without creating an agent and is idempotent', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithGapTask(db);
    const proposal = await proposeAgentForGap(db, taskId, { proposer: proposerFor(validSpec) });

    const rejected = rejectProposal(db, proposal.id);
    expect(rejected.status).toBe('rejected');
    expect(db.customAgents.all()).toHaveLength(0);
    expect(rejectProposal(db, proposal.id).status).toBe('rejected'); // idempotent
    expect(db.companyEvents.forMission(missionId).map((e) => e.type)).toContain('AGENT_REJECTED');

    // A rejected proposal can no longer be promoted.
    expect(() => promoteProposal(db, proposal.id)).toThrow();
  });
});

describe('retireTemporaryAgents', () => {
  test('disables the agent and removes its capabilities when the mission is terminal', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithGapTask(db);
    const proposal = await proposeAgentForGap(db, taskId, { proposer: proposerFor(validSpec) });
    const { agentId } = promoteProposal(db, proposal.id);

    // Not terminal yet → no-op.
    expect(retireTemporaryAgents(db, missionId)).toEqual([]);
    updateMission(db, missionId, { status: 'cancelled' });

    const retired = retireTemporaryAgents(db, missionId);
    expect(retired).toContain(agentId);
    expect(db.customAgents.get(agentId)!.enabled).toBe(false);
    expect(resolveAgentsForCapabilities(db, ['research.web'], { mode: 'all' })).toHaveLength(0); // no longer matches
    expect(db.companyEvents.forMission(missionId).map((e) => e.type)).toContain('AGENT_RETIRED');
  });
});

describe('end-to-end: gap → propose → approve → managerStep dispatches → complete → retire', () => {
  test('the full human-gated factory loop', async () => {
    const db = openDb(':memory:');
    const { missionId, taskId } = missionWithGapTask(db);

    const proposal = await proposeAgentForGap(db, taskId, { proposer: proposerFor(validSpec) });
    const { agentId } = promoteProposal(db, proposal.id);

    const step = await managerStep(db, missionId);

    const task = getCompanyTask(db, taskId)!;
    expect(task.status).toBe('completed');
    expect(task.assignedAgentId).toBe(agentId);
    expect(step.mission.status).toBe('completed');
    // The single-task mission completed → its temporary factory agent was retired.
    expect(db.customAgents.get(agentId)!.enabled).toBe(false);
    const types = db.companyEvents.forMission(missionId).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['AGENT_PROPOSED', 'AGENT_PROMOTED', 'MISSION_COMPLETED', 'AGENT_RETIRED']));
  });
});
