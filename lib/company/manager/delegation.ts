/**
 * Delegation / dispatch (Architecture V2 · F1) — the Manager requests execution
 * through EXISTING infrastructure; it never builds a parallel engine.
 *   - Agent path    → the existing agent runtime (`createRuntime(...).run(id)` →
 *                     an `agent_runs` row). Synchronous.
 *   - Workflow path → the existing Workflow Engine (`startRun`) on the PUBLISHED
 *                     immutable version only. Fire-and-forget; Phase-E approvals
 *                     remain authoritative; completion is synced by `reconcileTask`.
 *
 * Durable: task state + execution refs live in the DB, so running/waiting/failed/
 * completed survive restart. Idempotent: a running/terminal task is never
 * re-dispatched; one artifact per task execution (guarded via the event ledger).
 * Bounded & human-controlled — no autonomous loop, no Agent Factory, no capability
 * invention: an unmatched task reports a CAPABILITY_GAP and stays queued.
 */
import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import type { CompanyTask } from '@/lib/company/model';
import { allRuntimeAgents, getAgentById, resolveAgentsForCapabilities, agentToolSlugs } from '@/lib/agents/registry';
import { toolRequirementFor, satisfiesToolRequirement } from '@/lib/agents/capability-tools';
import { WIRED_TOOL_SLUGS } from '@/lib/agents/agent-tools';
import { createRuntime, type AgentRuntime } from '@/lib/agents/runtime';
import { buildAgentPresence } from '@/lib/agents/presence-service';
import { validateExecutable } from '@/lib/flows/validator';
import { startRun, reconcile } from '@/lib/flows/coordinator';
import { CompanyError, getCompanyTask, getTaskDependencies, updateCompanyTask, assignTask } from '@/lib/company/service';
import { chooseDispatchTarget, selectAgent } from '@/lib/company/manager/model';
import { appendEvent } from '@/lib/company/manager/events';
import { createArtifact } from '@/lib/company/manager/artifacts';
import { beginTaskAttempt, recordTaskFailure } from '@/lib/company/manager/retry';

export type DispatchResult =
  | { outcome: 'dispatched_agent'; task: CompanyTask; agentRunId: string; ok: boolean; artifactId?: string }
  | { outcome: 'dispatched_workflow'; task: CompanyTask; runId: string }
  | { outcome: 'capability_gap'; taskId: string; requiredCapabilities: string[]; missingCapabilities: string[]; reason: 'capability_gap' | 'no_target'; toolGap?: string[] }
  | { outcome: 'waiting_dependency'; task: CompanyTask }
  | { outcome: 'already_active'; task: CompanyTask };

const TERMINAL: CompanyTask['status'][] = ['completed', 'failed', 'cancelled'];

// Reliability G2 — the set of Company Task ids whose AGENT dispatch is executing IN THIS
// process right now. Agent dispatch is synchronous + in-process, so a task is only
// legitimately `running` while its id is in this set. Next bundles routes separately and
// this must survive that, so (like the flow coordinator's active-run set, INC-001/D11) it
// is pinned to `globalThis`. After a process restart the set is empty ⇒ any `running` agent
// task is provably stale (its execution cannot still be alive). Never a wall-clock guess.
declare global {
  // eslint-disable-next-line no-var
  var __igrisActiveAgentTasks: Set<string> | undefined;
}
const activeAgentTasks: Set<string> = (globalThis.__igrisActiveAgentTasks ??= new Set<string>());

/** True while THIS process is actively dispatching the given task to an agent. */
export function isAgentTaskActive(taskId: string): boolean {
  return activeAgentTasks.has(taskId);
}

/**
 * DISPATCH PREFLIGHT — the capabilities this agent CANNOT actually perform because it
 * lacks the required, wired tool. Uses canonical tool assignments + the wired registry
 * (never instructions). Empty ⇒ the agent is genuinely tool-eligible for the task. This
 * is the last line of defence: it runs even when an agent is directly assigned (bypassing
 * the resolver) and even if a tool/connection changed after selection.
 */
function taskToolGap(db: FounderDb, task: CompanyTask, agentId: string): string[] {
  const agentTools = agentToolSlugs(db, agentId);
  const available = new Set(WIRED_TOOL_SLUGS);
  const unmet: string[] = [];
  for (const cap of task.requiredCapabilities) {
    const req = toolRequirementFor(cap);
    if (req && !satisfiesToolRequirement(req, agentTools, available)) unmet.push(cap);
  }
  return unmet;
}

/** Set the F1 execution pointer without touching status (never overloads runId for agents). */
function setExecution(db: FounderDb, taskId: string, kind: 'agent' | 'workflow', refId: string): CompanyTask {
  const t = db.companyTasks.get(taskId)!;
  const updated: CompanyTask = {
    ...t,
    executionKind: kind,
    executionRefId: refId,
    runId: kind === 'workflow' ? refId : t.runId, // workflow run also fills the F0.2 runId seam
    updatedAt: new Date().toISOString(),
  };
  db.companyTasks.insert(updated);
  return updated;
}

/**
 * Dispatch ONE company task to its target. Idempotent, dependency-aware, and
 * deterministic in target selection. Returns a structured outcome (never throws
 * for a capability gap — that is a first-class result F2 will later consume).
 */
export async function dispatchTask(db: FounderDb, taskId: string, opts: { runtime?: AgentRuntime } = {}): Promise<DispatchResult> {
  const task = getCompanyTask(db, taskId);
  if (!task) throw new CompanyError('task not found', 404);

  // Idempotency: never dispatch a running or terminal task twice.
  if (task.status === 'running' || TERMINAL.includes(task.status)) return { outcome: 'already_active', task };

  // Dependency guard — prerequisites must all be completed.
  if (!getTaskDependencies(db, taskId).satisfied) {
    const t = task.status === 'waiting_dependency' ? task : safeTransition(db, taskId, 'waiting_dependency') ?? task;
    return { outcome: 'waiting_dependency', task: t };
  }

  // Resolve the target deterministically (capability match → presence refinement).
  const eligible = task.requiredCapabilities.length ? resolveAgentsForCapabilities(db, task.requiredCapabilities, { mode: 'all' }) : [];
  const eligibleIds = eligible.map((m) => m.agentId);
  const busy = new Set(buildAgentPresence(db).filter((p) => p.state === 'working' || p.state === 'waiting_approval').map((p) => p.agentId));
  // A directly-assigned agent must ALSO be tool-eligible — an assignment can never override
  // a real tool gap (e.g. a stale/pre-fix `research.web` assignment to a tool-less agent).
  const assignedExists = !!(task.assignedAgentId && getAgentById(db, task.assignedAgentId));
  const assignedToolGap = assignedExists ? taskToolGap(db, task, task.assignedAgentId!) : [];
  const assignedValid = assignedExists && assignedToolGap.length === 0 ? task.assignedAgentId : undefined;
  let chosenAgentId = assignedValid ?? selectAgent(eligibleIds, busy) ?? undefined;
  const hasPublishedWorkflow = !!(task.workflowId && db.flowWorkflows.get(task.workflowId)?.currentVersion != null);

  // Final defensive preflight: never start an agent that lacks a required, wired tool.
  let toolGapCaps: string[] = [];
  if (chosenAgentId) {
    toolGapCaps = taskToolGap(db, task, chosenAgentId);
    if (toolGapCaps.length) chosenAgentId = undefined; // do NOT dispatch a capability-label-only agent
  }
  // If the assigned agent was excluded purely for a tool gap and no alternative was found,
  // surface the SPECIFIC tool reason rather than a generic capability gap.
  if (!chosenAgentId && assignedToolGap.length && !toolGapCaps.length) toolGapCaps = assignedToolGap;

  const target = chooseDispatchTarget({
    workflowId: task.workflowId,
    hasPublishedWorkflow,
    chosenAgentId,
    requiredCapabilities: task.requiredCapabilities,
    missingCapabilities: eligible.length ? [] : task.requiredCapabilities,
  });

  if (target.kind === 'gap') {
    // Distinguish a TOOL gap (a required capability is tool-backed but NO agent has the
    // required wired tool) from a plain capability gap. This keeps the reason honest even
    // when no agent was pre-assigned — the label can never be satisfied without the tool.
    const available = new Set(WIRED_TOOL_SLUGS);
    const unsatisfiableToolCaps = toolGapCaps.length
      ? toolGapCaps
      : task.requiredCapabilities.filter((cap) => {
          const req = toolRequirementFor(cap);
          return !!req && db.customAgents.all().every((a) => !satisfiesToolRequirement(req, a.tools ?? [], available));
        });
    const toolGap = unsatisfiableToolCaps.length > 0;
    appendEvent(db, {
      type: 'CAPABILITY_GAP',
      missionId: task.missionId,
      taskId,
      summary: toolGap
        ? `Tool gap: ${unsatisfiableToolCaps.join(', ')} requires a tool that is not available`
        : `Capability gap: ${task.requiredCapabilities.join(', ') || 'no eligible target'}`,
      metadata: { reason: toolGap ? 'tool_gap' : target.reason },
    });
    toolGapCaps = unsatisfiableToolCaps;
    // Task stays queued — F1 NEVER creates an agent (that is F2, which consumes this gap).
    // No agent run is spent pretending to perform work the agent cannot do.
    return { outcome: 'capability_gap', taskId, requiredCapabilities: task.requiredCapabilities, missingCapabilities: target.missingCapabilities, reason: target.reason, toolGap: toolGap ? toolGapCaps : undefined };
  }
  if (target.kind === 'workflow') return dispatchWorkflow(db, task, target.workflowId);
  return dispatchAgent(db, task, target.agentId, opts.runtime ?? createRuntime(db, allRuntimeAgents(db)));
}

/** Try a status transition; return null if the central F0.2 transition model rejects it. */
function safeTransition(db: FounderDb, taskId: string, status: CompanyTask['status']): CompanyTask | null {
  try {
    return updateCompanyTask(db, taskId, { status });
  } catch {
    return null;
  }
}

// ── Agent path (synchronous) ─────────────────────────────────────────────────
async function dispatchAgent(db: FounderDb, task: CompanyTask, agentId: string, runtime: AgentRuntime): Promise<DispatchResult> {
  // G2: mark this task ACTIVE for the whole in-process dispatch so a concurrent recovery
  // pass never treats a genuinely-running dispatch as stale. Cleared in `finally` even on throw.
  activeAgentTasks.add(task.id);
  try {
    return await runAgentDispatch(db, task, agentId, runtime);
  } finally {
    activeAgentTasks.delete(task.id);
  }
}

async function runAgentDispatch(db: FounderDb, task: CompanyTask, agentId: string, runtime: AgentRuntime): Promise<DispatchResult> {
  const missionId = task.missionId;

  // Assign (F0.2 compat-checked) → assigned → running.
  if (task.assignedAgentId !== agentId) assignTask(db, task.id, agentId);
  let t = getCompanyTask(db, task.id)!;
  if (t.status === 'queued') t = updateCompanyTask(db, t.id, { status: 'assigned' });
  appendEvent(db, { type: 'TASK_ASSIGNED', missionId, taskId: t.id, agentId, summary: `Assigned to ${agentId}` });
  t = updateCompanyTask(db, t.id, { status: 'running' });
  // Reliability G1: count this real execution attempt exactly once (at `running`).
  t = beginTaskAttempt(db, t.id);
  const attempt = t.attemptCount;
  appendEvent(db, { type: 'TASK_DISPATCHED', missionId, taskId: t.id, agentId, summary: `Dispatched to agent ${agentId}` });
  appendEvent(db, { type: 'AGENT_STARTED', missionId, taskId: t.id, agentId, summary: `Agent ${agentId} started (attempt ${attempt}/${t.maxAttempts})` });

  // Execute via the EXISTING agent runtime (persists an agent_runs row).
  const run = await runtime.run(agentId);
  t = setExecution(db, t.id, 'agent', run.id);

  let artifactId: string | undefined;
  if (run.ok) {
    // One artifact per task execution (idempotency guard).
    if (db.companyEvents.countForTask(t.id, 'ARTIFACT_CREATED') === 0) {
      const artifact = createArtifact(db, {
        missionId,
        taskId: t.id,
        producedByAgentId: agentId,
        type: 'agent_result',
        title: `${task.title} — result`,
        summary: run.summary.slice(0, 2000),
        content: run.summary,
        contentType: 'text/plain',
        sourceRefs: [run.id],
      });
      artifactId = artifact.id;
      appendEvent(db, { type: 'ARTIFACT_CREATED', missionId, taskId: t.id, agentId, artifactId, summary: `Artifact: ${artifact.title}` });
    }
    t = updateCompanyTask(db, t.id, { status: 'completed' });
    appendEvent(db, { type: 'TASK_COMPLETED', missionId, taskId: t.id, agentId, summary: `Task completed by ${agentId}` });
  } else {
    t = updateCompanyTask(db, t.id, { status: 'failed' });
    // Reliability G1: preserve the failure code + classification for the retry decision.
    const rec = recordTaskFailure(db, t.id, { code: run.errorCode, summary: run.summary });
    t = rec?.task ?? t;
    appendEvent(db, {
      type: 'TASK_FAILED',
      missionId,
      taskId: t.id,
      agentId,
      summary: `Task failed (attempt ${t.attemptCount}/${t.maxAttempts})`,
      metadata: { error: run.summary.slice(0, 160), code: run.errorCode ?? null, class: rec?.decision.class ?? null, attempt: t.attemptCount },
    });
  }
  return { outcome: 'dispatched_agent', task: t, agentRunId: run.id, ok: run.ok, artifactId };
}

// ── Workflow path (async; existing engine owns the run) ──────────────────────
function dispatchWorkflow(db: FounderDb, task: CompanyTask, workflowId: string): DispatchResult {
  const wf = db.flowWorkflows.get(workflowId);
  const version = wf?.currentVersion;
  if (version == null) throw new CompanyError('workflow has no published version (never runs a draft)', 400);
  const snapshot = db.flowVersions.get(workflowId, version);
  if (!snapshot) throw new CompanyError('published workflow version missing', 400);

  const agents = allRuntimeAgents(db);
  const validation = validateExecutable(snapshot.graph, { agentIds: new Set(agents.map((a) => a.id)) });
  if (!validation.ok) throw new CompanyError('workflow is not runnable', 400);

  let t = getCompanyTask(db, task.id)!;
  if (t.status === 'queued') t = updateCompanyTask(db, t.id, { status: 'assigned' });
  t = updateCompanyTask(db, t.id, { status: 'running' });
  // Reliability G1: count this real execution attempt exactly once (at `running`).
  t = beginTaskAttempt(db, t.id);

  // Create + launch the run through the EXISTING coordinator (immutable published version).
  const run = db.flowRuns.create({ id: `run-${randomUUID()}`, workflowId, workflowVersion: version, startingInput: { text: (task.objective ?? task.title).slice(0, 20_000) } });
  startRun(db, run, snapshot.graph, agents);
  t = setExecution(db, t.id, 'workflow', run.id);

  appendEvent(db, { type: 'TASK_DISPATCHED', missionId: task.missionId, taskId: t.id, workflowId, summary: `Dispatched to workflow ${workflowId}` });
  appendEvent(db, { type: 'WORKFLOW_STARTED', missionId: task.missionId, taskId: t.id, workflowId, summary: `Workflow run started`, metadata: { runId: run.id, version } });
  return { outcome: 'dispatched_workflow', task: t, runId: run.id };
}

/**
 * Sync a running WORKFLOW task from its flow run (idempotent; acts only on a
 * `running` workflow task). success → completed + artifact; failed/interrupted →
 * failed; waiting_approval → waiting_approval (Phase E owns the actual approval —
 * F1 creates NO company approval). Reconcile also detects stale runs (restart).
 */
export function reconcileTask(db: FounderDb, taskId: string): CompanyTask | null {
  const task = getCompanyTask(db, taskId);
  if (!task || task.status !== 'running' || task.executionKind !== 'workflow' || !task.executionRefId) return task;

  const run = reconcile(db, task.executionRefId); // stale `running` run → interrupted
  if (!run) return task;
  const missionId = task.missionId;

  if (run.status === 'success') {
    if (db.companyEvents.countForTask(taskId, 'ARTIFACT_CREATED') === 0) {
      const artifact = createArtifact(db, {
        missionId,
        taskId,
        workflowRunId: run.id,
        type: 'workflow_result',
        title: `${task.title} — workflow result`,
        summary: `Workflow run ${run.id} completed`,
        sourceRefs: [run.id],
      });
      appendEvent(db, { type: 'ARTIFACT_CREATED', missionId, taskId, artifactId: artifact.id, workflowId: task.workflowId, summary: `Artifact: ${artifact.title}` });
    }
    const t = updateCompanyTask(db, taskId, { status: 'completed' });
    appendEvent(db, { type: 'TASK_COMPLETED', missionId, taskId, workflowId: task.workflowId, summary: `Workflow task completed` });
    return t;
  }
  if (run.status === 'failed' || run.status === 'interrupted') {
    let t = updateCompanyTask(db, taskId, { status: 'failed' });
    // Reliability G1: preserve the workflow run's error code for the retry decision.
    const rec = recordTaskFailure(db, taskId, { code: run.errorCode ?? run.status, summary: run.errorMessage ?? `workflow ${run.status}` });
    t = rec?.task ?? t;
    appendEvent(db, { type: 'TASK_FAILED', missionId, taskId, workflowId: task.workflowId, summary: `Workflow task ${run.status} (attempt ${t.attemptCount}/${t.maxAttempts})`, metadata: { runStatus: run.status, code: run.errorCode ?? null, class: rec?.decision.class ?? null, attempt: t.attemptCount } });
    return t;
  }
  if (run.status === 'waiting_approval') {
    const t = updateCompanyTask(db, taskId, { status: 'waiting_approval' });
    if (db.companyEvents.countForTask(taskId, 'APPROVAL_REQUIRED') === 0) {
      appendEvent(db, { type: 'APPROVAL_REQUIRED', missionId, taskId, workflowId: task.workflowId, summary: `Waiting on Human Approval (Phase E)` });
    }
    return t;
  }
  return task; // still running/queued in the engine
}
