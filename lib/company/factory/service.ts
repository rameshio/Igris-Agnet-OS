/**
 * Agent Factory service (Architecture V2 · F2) — the human-gated bridge that turns a
 * F1 CAPABILITY_GAP into a real, capability-assigned agent, WITHOUT ever creating one
 * silently or autonomously.
 *
 * The flow is deliberately four discrete, operator-driven steps:
 *   1. proposeAgentForGap  — LLM proposes a spec; SERVER validates it against policy;
 *                            a PENDING proposal is stored. NO agent, NO capability yet.
 *   2. promoteProposal     — a human approves → the agent is CREATED (reusing the
 *                            existing createCustomAgent path under the policy) and the
 *                            gap capabilities are assigned, so the F1 resolver now
 *                            matches and the next managerStep dispatches the task.
 *   3. rejectProposal      — a human rejects → nothing is created.
 *   4. retireTemporaryAgents — on a terminal mission, temporary factory agents are
 *                            disabled + unassigned (reversible; bounded; no loop).
 *
 * Planning-≠-execution discipline (as in F1): the LLM proposes, the SERVER owns
 * safety. Capabilities granted are ALWAYS exactly the task's gap (never the LLM's
 * choice). Promotion/rejection use an idempotent conditional transition, mirroring the
 * Phase-E resolveApproval pattern — a double-click promotes exactly once. The proposer
 * is injectable so the whole pipeline is testable without a live model.
 */
import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import { chat as llmChat } from '@/lib/connectors/llm';
import { CompanyError, getCompanyTask, getMission } from '@/lib/company/service';
import { createCustomAgent, updateCustomAgent } from '@/lib/agents/custom';
import { getAgentById, resolveAgentsForCapabilities } from '@/lib/agents/registry';
import { appendEvent } from '@/lib/company/manager/events';
import { isMissionTerminal } from '@/lib/company/model';
import type { CompanyTask } from '@/lib/company/model';
import {
  AgentSpecSchema,
  resolvePolicy,
  safeProposalSummary,
  validateSpecAgainstPolicy,
  type AgentProposal,
  type AgentSpec,
  type FactoryPolicy,
} from '@/lib/company/factory/model';

const LOCAL_ACTOR = 'local_operator';

/** A proposer produces raw text containing a JSON agent spec. Injectable for tests. */
export type Proposer = (input: { task: CompanyTask; missing: string[]; policy: FactoryPolicy }) => Promise<string>;

/** Extract + validate a JSON agent spec from raw proposer text (fenced or bare). Fails safely. */
export function parseAgentSpec(raw: string): AgentSpec {
  const fence = /```(?:json|spec)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fence?.[1] ?? /\{[\s\S]*\}/.exec(raw)?.[0] ?? null;
  if (!candidate) throw new CompanyError('proposer did not return a JSON agent spec', 400);
  let json: unknown;
  try {
    json = JSON.parse(candidate.trim());
  } catch {
    throw new CompanyError('proposer returned invalid JSON', 400);
  }
  return AgentSpecSchema.parse(json); // ZodError → 400 via companyErrorInfo
}

/**
 * Is this task a REAL capability gap (the only thing the factory may fill)?
 * Mirrors the F1 report/dispatch policy: it must declare capabilities, have no valid
 * assigned agent, no published workflow, and no eligible agent under mode `all`.
 */
export function gapForTask(db: FounderDb, task: CompanyTask): { gap: boolean; missing: string[] } {
  if (task.requiredCapabilities.length === 0) return { gap: false, missing: [] };
  if (task.assignedAgentId && getAgentById(db, task.assignedAgentId)) return { gap: false, missing: [] };
  const hasWorkflow = !!(task.workflowId && db.flowWorkflows.get(task.workflowId)?.currentVersion != null);
  if (hasWorkflow) return { gap: false, missing: [] };
  const eligible = resolveAgentsForCapabilities(db, task.requiredCapabilities, { mode: 'all' });
  if (eligible.length > 0) return { gap: false, missing: [] };
  return { gap: true, missing: task.requiredCapabilities };
}

/** The default LLM proposer — grounded on the gap + the policy's grantable tools/models. */
function defaultProposer(): Proposer {
  return async ({ task, missing, policy }) => {
    const system = [
      'You are the IGRIS Agent Factory. Propose ONE specialist agent to fill a capability gap.',
      'Output ONLY a JSON object, no prose, matching:',
      '{"name":"...","description":"...","instructions":"<the agent\'s system prompt>","model":"","tools":["slack"],"requiredCapabilities":["domain.action"],"rationale":"..."}',
      `Capabilities to cover: ${missing.join(', ')}`,
      `You may grant ONLY these tools: ${policy.allowedTools.join(', ')} (at most ${policy.maxTools}; grant none if unsure).`,
      `model MUST be one of: ${policy.allowedModels.map((m) => m || '(default)').join(', ')} — prefer "" (the system default).`,
      'instructions: concise, specific, and honest about what the agent cannot access.',
    ].join('\n');
    const res = await llmChat({ system, messages: [{ role: 'user', content: `Task: ${task.title}\nObjective: ${task.objective ?? '(none)'}` }] });
    return res.text;
  };
}

/**
 * STEP 1 — propose (no agent created). Verifies a real gap, runs the injectable
 * proposer, validates the spec against policy (violation ⇒ 400, nothing persisted),
 * and stores a PENDING proposal. Capabilities recorded are the ACTUAL gap (server-owned),
 * not the LLM's — so promotion can only ever grant what the task required.
 */
export async function proposeAgentForGap(
  db: FounderDb,
  taskId: string,
  opts: { proposer?: Proposer; policyOverride?: unknown } = {},
): Promise<AgentProposal> {
  const task = getCompanyTask(db, taskId);
  if (!task) throw new CompanyError('task not found', 404);
  const { gap, missing } = gapForTask(db, task);
  if (!gap) throw new CompanyError('task has no capability gap to fill', 409);

  const policy = resolvePolicy(opts.policyOverride);
  const proposer = opts.proposer ?? defaultProposer();
  const raw = await proposer({ task, missing, policy });
  const proposed = parseAgentSpec(raw);

  // SERVER owns the grant: the agent fills EXACTLY the gap, never the LLM's capability list.
  const spec: AgentSpec = { ...proposed, requiredCapabilities: missing };

  const depth = 1; // operator-initiated, top-level creation
  const check = validateSpecAgainstPolicy(spec, policy, depth);
  if (!check.ok) throw new CompanyError(`proposed agent violates factory policy: ${check.violations.join('; ')}`, 400);

  const now = new Date().toISOString();
  const proposal: AgentProposal = {
    id: `prop-${randomUUID()}`,
    missionId: task.missionId,
    taskId: task.id,
    status: 'pending',
    spec,
    policy,
    requiredCapabilities: missing,
    rationale: spec.rationale,
    temporary: true,
    maxDepth: policy.maxDepth,
    budgetUsd: policy.budgetUsd,
    createdAt: now,
    updatedAt: now,
  };
  db.companyAgentProposals.insert(proposal);

  const s = safeProposalSummary(proposal);
  appendEvent(db, {
    type: 'AGENT_PROPOSED',
    missionId: proposal.missionId,
    taskId: proposal.taskId,
    summary: `Proposed agent: ${s.agentName}`,
    metadata: { proposalId: proposal.id, capabilities: s.requiredCapabilities.join(',') || '(none)', tools: s.tools.join(',') || '(none)' },
  });
  return proposal;
}

export type PromoteResult = { proposal: AgentProposal; agentId: string; created: boolean };

/**
 * STEP 2 — promote (human-approved). Idempotent: only a PENDING proposal is created;
 * a second approve returns the already-created agent (created:false). On the winning
 * transition it upserts the gap capability definitions, CREATES the agent via the
 * existing createCustomAgent path (under the stored policy), assigns exactly the gap
 * capabilities, and links the agent onto the proposal.
 */
export function promoteProposal(db: FounderDb, proposalId: string, opts: { actor?: string } = {}): PromoteResult {
  const existing = db.companyAgentProposals.get(proposalId);
  if (!existing) throw new CompanyError('proposal not found', 404);
  if (existing.status !== 'pending') {
    if (existing.status === 'approved' && existing.agentId) return { proposal: existing, agentId: existing.agentId, created: false };
    throw new CompanyError(`proposal already ${existing.status}`, 409);
  }

  const actor = opts.actor?.trim() || LOCAL_ACTOR;
  const resolved = db.companyAgentProposals.resolve(proposalId, 'approved', actor);
  if (!resolved) {
    // Lost the race to a concurrent approve — return that call's result if it created the agent.
    const after = db.companyAgentProposals.get(proposalId)!;
    if (after.status === 'approved' && after.agentId) return { proposal: after, agentId: after.agentId, created: false };
    throw new CompanyError(`proposal already ${after.status}`, 409);
  }

  // Ensure the capability definitions exist so the resolver + /capabilities stay honest.
  for (const capId of resolved.requiredCapabilities) db.capabilities.upsert({ id: capId, name: capId });

  // CREATE the agent through the existing path (policy wrapper — not a fork of creation).
  const spec = resolved.spec;
  const agent = createCustomAgent(db, {
    name: spec.name,
    description: spec.description,
    departmentId: resolved.policy.defaultDepartmentId,
    instructions: spec.instructions,
    model: spec.model,
    tools: spec.tools,
    enabled: true,
  });

  // Assign EXACTLY the gap capabilities → the F1 resolver now matches this agent.
  for (const capId of resolved.requiredCapabilities) db.agentCapabilities.assign(agent.id, { capabilityId: capId, source: 'explicit' });
  db.companyAgentProposals.setAgent(proposalId, agent.id);

  const final = db.companyAgentProposals.get(proposalId)!;
  const s = safeProposalSummary(final);
  appendEvent(db, {
    type: 'AGENT_PROMOTED',
    missionId: final.missionId,
    taskId: final.taskId,
    agentId: agent.id,
    summary: `Promoted agent: ${s.agentName}`,
    metadata: { proposalId, capabilities: s.requiredCapabilities.join(',') || '(none)', actor },
  });
  return { proposal: final, agentId: agent.id, created: true };
}

/** STEP 3 — reject (human). Idempotent; creates nothing. */
export function rejectProposal(db: FounderDb, proposalId: string, opts: { actor?: string } = {}): AgentProposal {
  const existing = db.companyAgentProposals.get(proposalId);
  if (!existing) throw new CompanyError('proposal not found', 404);
  if (existing.status !== 'pending') {
    if (existing.status === 'rejected') return existing;
    throw new CompanyError(`proposal already ${existing.status}`, 409);
  }

  const actor = opts.actor?.trim() || LOCAL_ACTOR;
  const resolved = db.companyAgentProposals.resolve(proposalId, 'rejected', actor);
  if (!resolved) {
    const after = db.companyAgentProposals.get(proposalId)!;
    if (after.status === 'rejected') return after;
    throw new CompanyError(`proposal already ${after.status}`, 409);
  }
  appendEvent(db, {
    type: 'AGENT_REJECTED',
    missionId: resolved.missionId,
    taskId: resolved.taskId,
    summary: `Rejected agent: ${resolved.spec.name}`,
    metadata: { proposalId, actor },
  });
  return resolved;
}

/**
 * STEP 4 — retire temporary factory agents when their mission is TERMINAL. Disables
 * the agent (reversible — not deleted) and removes its capability assignments so the
 * resolver no longer matches it. Bounded, deterministic, one pass; no loop. Returns
 * the retired agent ids.
 */
export function retireTemporaryAgents(db: FounderDb, missionId: string): string[] {
  const mission = getMission(db, missionId);
  if (!mission || !isMissionTerminal(mission.status)) return [];

  const retired: string[] = [];
  for (const p of db.companyAgentProposals.forMission(missionId)) {
    if (p.status !== 'approved' || !p.temporary || !p.agentId) continue;
    const agent = db.customAgents.get(p.agentId);
    if (!agent || !agent.enabled) continue; // already retired / not a custom agent
    updateCustomAgent(db, p.agentId, { enabled: false });
    for (const capId of p.requiredCapabilities) db.agentCapabilities.remove(p.agentId, capId);
    appendEvent(db, {
      type: 'AGENT_RETIRED',
      missionId,
      agentId: p.agentId,
      summary: `Retired temporary agent: ${agent.name}`,
      metadata: { proposalId: p.id },
    });
    retired.push(p.agentId);
  }
  return retired;
}
