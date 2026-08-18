/**
 * IGRIS Commander action registry (UX Foundation U3 — Plan → Preview → Execute).
 *
 * This is the ONLY place the Commander's DO lane turns intent into a side effect,
 * and it does so through a HARD safety funnel:
 *
 *     text → recognizeCommanderAction()   (typed proposal, or missing-context/unknown)
 *          → previewPlan()  (which existing GET resolves authoritative data)
 *          → build*Preview()  (pure card from that data — never from raw text)
 *          → [ explicit human confirm in the UI ]
 *          → executePlan()  (a fixed, typed → existing-mutation-route map)
 *          → format*Result()
 *
 * Invariants enforced here and by tests:
 *  - The LLM/Conductor may only *select* a registered action TYPE. It can never
 *    supply an endpoint, method, body, URL, SQL, or shell — executePlan derives
 *    those from the typed action alone. Unknown types are rejected.
 *  - Recognition NEVER executes. It returns data only.
 *  - A typed action is only produced when its REQUIRED CONTEXT is present in the
 *    U1 envelope. Missing context → a "missing" result, never a guess.
 *  - Previews/results contain NO secrets, tokens, prompts, graphs, or payloads —
 *    identifiers + safe status only.
 *  - Risk is never under-claimed: when downstream effects are unknown, it is raised.
 *
 * Pure & framework-free (no React, no fetch) so the whole funnel is unit-testable.
 */
import type { IgrisContextEnvelope } from '@/lib/context-envelope';
import type { ValidationResult } from '@/lib/flows/validator';

// ── Typed action model ──────────────────────────────────────────────────────

export type CommanderActionType =
  | 'run_workflow'
  | 'publish_workflow'
  | 'delete_workflow'
  | 'resolve_approval'
  | 'set_hermes_transport';

export type CommanderAction =
  | { type: 'run_workflow'; workflowId: string }
  | { type: 'publish_workflow'; workflowId: string }
  | { type: 'delete_workflow'; workflowId: string }
  | { type: 'resolve_approval'; approvalId: string; decision: 'approve' | 'reject' }
  | { type: 'set_hermes_transport'; transport: 'acp' | 'serve' };

/** The complete allow-list of executable types. LLM output is validated against this. */
export const COMMANDER_ACTION_TYPES: readonly CommanderActionType[] = [
  'run_workflow',
  'publish_workflow',
  'delete_workflow',
  'resolve_approval',
  'set_hermes_transport',
];

export type RiskLevel = 'low' | 'medium' | 'high';

// ── Registry (metadata per action type) ─────────────────────────────────────

type ActionSpec = {
  /** Human title shown on the preview card. */
  title: string;
  /** Never under-claimed: unknown downstream effect ⇒ higher risk. */
  risk: RiskLevel;
  /** Envelope keys that MUST be present for the action to be proposable. */
  requiredContext: (keyof IgrisContextEnvelope)[];
  /** Confirm-button label. */
  confirmLabel: string;
};

const REGISTRY: Record<CommanderActionType, ActionSpec> = {
  // Running invokes executors that may reach external tools — downstream effect
  // is not fully known at the Commander level ⇒ MEDIUM, not LOW.
  run_workflow: { title: 'Run workflow', risk: 'medium', requiredContext: ['workflowId'], confirmLabel: 'Confirm Run' },
  publish_workflow: { title: 'Publish workflow', risk: 'medium', requiredContext: ['workflowId'], confirmLabel: 'Confirm Publish' },
  // Destructive to the workspace listing (archive preserves history, but it still
  // removes the workflow from active use) ⇒ HIGH.
  delete_workflow: { title: 'Delete workflow', risk: 'high', requiredContext: ['workflowId'], confirmLabel: 'Confirm Delete' },
  // Resolving an approval releases a paused run down an irreversible route ⇒ HIGH.
  resolve_approval: { title: 'Resolve approval', risk: 'high', requiredContext: ['approvalId'], confirmLabel: 'Confirm' },
  // Switching production transport changes how every agent call is routed ⇒ MEDIUM.
  set_hermes_transport: { title: 'Switch Hermes transport', risk: 'medium', requiredContext: [], confirmLabel: 'Confirm Switch' },
};

export function actionSpec(type: CommanderActionType): ActionSpec {
  return REGISTRY[type];
}

/** Validate an untyped action id (e.g. from the LLM). Unknown ids are rejected. */
export function isCommanderActionType(value: unknown): value is CommanderActionType {
  return typeof value === 'string' && (COMMANDER_ACTION_TYPES as readonly string[]).includes(value);
}

// ── Recognition (text + envelope → typed proposal | missing | unknown) ───────

export type RecognizeResult =
  | { kind: 'action'; action: CommanderAction; risk: RiskLevel; title: string }
  | { kind: 'missing'; type: CommanderActionType; title: string; missing: string[] }
  | { kind: 'unknown' };

/** Envelope key → the "this X" phrase a user says to reference it. */
const REQUIRED_CONTEXT_PHRASE: Partial<Record<keyof IgrisContextEnvelope, string>> = {
  workflowId: 'a workflow',
  approvalId: 'an approval',
};

function missingContext(env: IgrisContextEnvelope, keys: (keyof IgrisContextEnvelope)[]): string[] {
  return keys.filter((k) => env[k] === undefined || env[k] === null).map((k) => REQUIRED_CONTEXT_PHRASE[k] ?? String(k));
}

/**
 * Recognize a DO utterance as a typed action, grounded in the current envelope.
 * RECOGNITION ONLY — never executes. Deterministic keyword parsing; the LLM does
 * not choose the route, the verb does.
 */
export function recognizeCommanderAction(input: string, env: IgrisContextEnvelope): RecognizeResult {
  const text = input.trim().toLowerCase();
  if (!text) return { kind: 'unknown' };

  // Hermes transport — no context required; the target transport is explicit.
  if (/\bhermes\b/.test(text) || /\b(acp|serve)\b/.test(text)) {
    if (/\b(run|publish|delete|approve|reject)\b/.test(text)) {
      // a workflow/approval verb also present — fall through to those below
    } else {
      const transport: 'acp' | 'serve' | null = /\bserve\b/.test(text) ? 'serve' : /\bacp\b/.test(text) ? 'acp' : null;
      if (transport) return finalize({ type: 'set_hermes_transport', transport }, env);
    }
  }

  // Approval resolution.
  if (/^\s*(approve|reject|deny)\b/.test(text) || /\b(approve|reject|deny)\s+(this|the)\b/.test(text)) {
    const decision: 'approve' | 'reject' = /\b(reject|deny)\b/.test(text) ? 'reject' : 'approve';
    const spec = REGISTRY.resolve_approval;
    const miss = missingContext(env, spec.requiredContext);
    if (miss.length > 0) return { kind: 'missing', type: 'resolve_approval', title: spec.title, missing: miss };
    return finalize({ type: 'resolve_approval', approvalId: env.approvalId!, decision }, env);
  }

  // Workflow verbs.
  if (/\b(delete|remove|archive)\b/.test(text) && mentionsWorkflow(text, env)) {
    return proposeWorkflow('delete_workflow', env);
  }
  if (/\bpublish\b/.test(text) && mentionsWorkflow(text, env)) {
    return proposeWorkflow('publish_workflow', env);
  }
  if (/\brun\b/.test(text) && mentionsWorkflow(text, env)) {
    return proposeWorkflow('run_workflow', env);
  }

  return { kind: 'unknown' };
}

/** True when the utterance targets a workflow ("this workflow", or already on a workflow surface). */
function mentionsWorkflow(text: string, env: IgrisContextEnvelope): boolean {
  if (/\bworkflow\b|\bflow\b/.test(text)) return true;
  // "run this" / "publish it" while a workflow is the active context.
  return env.workflowId !== undefined && /\b(this|it|the current)\b/.test(text);
}

function proposeWorkflow(
  type: 'run_workflow' | 'publish_workflow' | 'delete_workflow',
  env: IgrisContextEnvelope,
): RecognizeResult {
  const spec = REGISTRY[type];
  const miss = missingContext(env, spec.requiredContext);
  if (miss.length > 0) return { kind: 'missing', type, title: spec.title, missing: miss };
  return finalize({ type, workflowId: env.workflowId! }, env);
}

function finalize(action: CommanderAction, env: IgrisContextEnvelope): RecognizeResult {
  const spec = REGISTRY[action.type];
  const miss = missingContext(env, spec.requiredContext);
  if (miss.length > 0) return { kind: 'missing', type: action.type, title: spec.title, missing: miss };
  return { kind: 'action', action, risk: spec.risk, title: spec.title };
}

// ── Route plans (typed action → existing API; the ONLY URL source) ───────────

export type FetchPlan = { method: 'GET' | 'POST' | 'DELETE'; path: string; body?: unknown };

/** GET that resolves authoritative preview data for an action. */
export function previewPlan(action: CommanderAction): FetchPlan {
  switch (action.type) {
    case 'run_workflow':
    case 'publish_workflow':
    case 'delete_workflow':
      return { method: 'GET', path: `/api/flows/${encodeURIComponent(action.workflowId)}` };
    case 'resolve_approval':
      return { method: 'GET', path: `/api/flow-approvals/${encodeURIComponent(action.approvalId)}` };
    case 'set_hermes_transport':
      return { method: 'GET', path: '/api/settings/hermes-runtime' };
  }
}

/** The mutation that EXECUTES an action — a fixed map to existing endpoints. */
export function executePlan(action: CommanderAction): FetchPlan {
  switch (action.type) {
    case 'run_workflow':
      return { method: 'POST', path: `/api/flows/${encodeURIComponent(action.workflowId)}/runs`, body: {} };
    case 'publish_workflow':
      return { method: 'POST', path: `/api/flows/${encodeURIComponent(action.workflowId)}/versions`, body: {} };
    case 'delete_workflow':
      return { method: 'DELETE', path: `/api/flows/${encodeURIComponent(action.workflowId)}` };
    case 'resolve_approval':
      return {
        method: 'POST',
        path: `/api/flow-approvals/${encodeURIComponent(action.approvalId)}/${action.decision === 'approve' ? 'approve' : 'reject'}`,
        body: {},
      };
    case 'set_hermes_transport':
      return { method: 'POST', path: '/api/settings/hermes-runtime', body: { action: 'set_transport', transport: action.transport } };
  }
}

// ── Preview card (pure builders over authoritative data) ─────────────────────

export type PreviewField = { label: string; value: string };

export type CommanderPreview = {
  action: CommanderAction;
  title: string;
  risk: RiskLevel;
  confirmLabel: string;
  fields: PreviewField[];
  effects: string[];
  warnings: string[];
  /** When true the UI must DISABLE confirm (e.g. validation failed, serve ineligible). */
  blocked: boolean;
  blockedReason?: string;
};

function base(action: CommanderAction): Omit<CommanderPreview, 'fields' | 'effects' | 'warnings' | 'blocked'> {
  const spec = REGISTRY[action.type];
  return { action, title: spec.title, risk: spec.risk, confirmLabel: spec.confirmLabel };
}

/** Shape returned by GET /api/flows/:id (subset the preview reads). */
export type WorkflowPreviewData = {
  workflow: { id: string; name: string; currentVersion: number | null; updatedAt?: string };
  versions?: { version: number; createdAt?: string }[];
  draftValidation?: ValidationResult | null;
};

export function buildRunPreview(action: Extract<CommanderAction, { type: 'run_workflow' }>, data: WorkflowPreviewData): CommanderPreview {
  const b = base(action);
  const published = data.workflow.currentVersion;
  const fields: PreviewField[] = [{ label: 'Workflow', value: data.workflow.name }];
  const effects = ['May invoke external tools via its executors.', 'Human Approval gates (Phase E) remain active — this does not bypass them.'];
  const warnings: string[] = [];

  if (published == null) {
    return { ...b, fields, effects: [], warnings: [], blocked: true, blockedReason: 'This workflow has no published version yet. Publish it before running.' };
  }
  fields.push({ label: 'Published version', value: `v${published}` });
  if (hasUnpublishedEdits(data)) {
    warnings.push(`Draft was saved after v${published} was published — it may contain unpublished changes. Running uses published v${published} (drafts are never auto-published).`);
  }
  return { ...b, fields, effects, warnings, blocked: false };
}

export function buildPublishPreview(action: Extract<CommanderAction, { type: 'publish_workflow' }>, data: WorkflowPreviewData): CommanderPreview {
  const b = base(action);
  const current = data.workflow.currentVersion;
  const next = (current ?? 0) + 1;
  const fields: PreviewField[] = [
    { label: 'Workflow', value: data.workflow.name },
    { label: 'Current published', value: current == null ? 'none' : `v${current}` },
    { label: 'Next version', value: `v${next}` },
  ];
  const validation = data.draftValidation ?? null;
  if (validation && !validation.ok) {
    const reason = validation.issues[0]?.message ?? 'The draft has validation errors.';
    fields.push({ label: 'Validation', value: 'invalid' });
    return { ...b, fields, effects: [], warnings: [], blocked: true, blockedReason: `Cannot publish — ${reason}` };
  }
  fields.push({ label: 'Validation', value: validation ? 'passes' : 'unknown' });
  return { ...b, fields, effects: [`Freezes the current draft as immutable v${next}.`, 'Existing versions and their run history are untouched.'], warnings: [], blocked: false };
}

export function buildDeletePreview(action: Extract<CommanderAction, { type: 'delete_workflow' }>, data: WorkflowPreviewData): CommanderPreview {
  const b = base(action);
  // hasHistory (backend rule) ⇔ at least one published version (runs require a
  // published version, so versions.length>0 covers both). Backend decides the
  // real mode; this is an honest prediction.
  const willArchive = (data.versions?.length ?? 0) > 0;
  const fields: PreviewField[] = [
    { label: 'Workflow', value: data.workflow.name },
    { label: 'Behavior', value: willArchive ? 'Archive (history exists)' : 'Hard delete (no history)' },
  ];
  const effects = willArchive
    ? ['Removed from the active workspace.', 'Historical versions and runs are preserved (audit-safe).']
    : ['Permanently removed — it has no published versions or runs.'];
  return { ...b, fields, effects, warnings: willArchive ? [] : ['This draft has no history and will be hard-deleted.'], blocked: false };
}

/** Safe subset of a FlowApproval the preview may read (no raw context blob). */
export type ApprovalPreviewData = {
  id: string;
  status: string;
  requestType?: string;
  title?: string;
  message?: string;
  workflowId?: string;
  workflowVersion?: number;
  runId?: string;
  approvalRoute?: string;
  rejectionRoute?: string;
};

export function buildApprovalPreview(action: Extract<CommanderAction, { type: 'resolve_approval' }>, data: ApprovalPreviewData): CommanderPreview {
  const b = { ...base(action), title: action.decision === 'approve' ? 'Approve request' : 'Reject request', confirmLabel: action.decision === 'approve' ? 'Confirm Approve' : 'Confirm Reject' };
  const fields: PreviewField[] = [];
  if (data.title) fields.push({ label: 'Request', value: data.title });
  if (data.workflowId) fields.push({ label: 'Workflow', value: `${data.workflowId}${data.workflowVersion != null ? ` v${data.workflowVersion}` : ''}` });
  if (data.runId) fields.push({ label: 'Run', value: data.runId });
  const route = action.decision === 'approve' ? data.approvalRoute : data.rejectionRoute;
  if (route) fields.push({ label: 'Routes down', value: route });

  if (data.status !== 'pending') {
    return { ...b, fields, effects: [], warnings: [], blocked: true, blockedReason: `This approval is already ${data.status}. It cannot be resolved again.` };
  }
  const effects = [
    action.decision === 'approve' ? 'Approves the request and resumes the paused run.' : 'Rejects the request and resumes the run down its reject route (a normal outcome, not a failure).',
  ];
  return { ...b, fields, effects, warnings: [], blocked: false };
}

/** Subset of GET /api/settings/hermes-runtime the preview reads. */
export type HermesPreviewData = {
  productionTransport?: 'acp' | 'serve';
  transport?: 'acp' | 'serve';
  eligibility?: { eligible: boolean; reasons?: string[] };
};

export function buildHermesPreview(action: Extract<CommanderAction, { type: 'set_hermes_transport' }>, data: HermesPreviewData): CommanderPreview {
  const b = base(action);
  const current = data.productionTransport ?? data.transport ?? 'acp';
  const fields: PreviewField[] = [
    { label: 'Current transport', value: current.toUpperCase() },
    { label: 'Target transport', value: action.transport.toUpperCase() },
  ];
  if (current === action.transport) {
    return { ...b, fields, effects: [], warnings: [`Already on ${action.transport.toUpperCase()} — nothing to switch.`], blocked: true, blockedReason: `Production transport is already ${action.transport.toUpperCase()}.` };
  }
  // Switching TO serve requires eligibility; ACP rollback is always allowed.
  if (action.transport === 'serve') {
    const elig = data.eligibility;
    const eligible = elig?.eligible === true;
    fields.push({ label: 'Serve eligible', value: eligible ? 'yes' : 'no' });
    if (!eligible) {
      const reasons = elig?.reasons?.length ? elig.reasons.join('; ') : 'runtime is not eligible yet';
      return { ...b, fields, effects: [], warnings: [], blocked: true, blockedReason: `Serve is not eligible for production: ${reasons}` };
    }
    return { ...b, fields, effects: ['Routes production agent traffic through Hermes Serve.'], warnings: [], blocked: false };
  }
  return { ...b, fields, effects: ['Rolls production agent traffic back to ACP.'], warnings: [], blocked: false };
}

/** Heuristic (honest, non-overclaiming): draft saved after the published version. */
function hasUnpublishedEdits(data: WorkflowPreviewData): boolean {
  const published = data.workflow.currentVersion;
  if (published == null) return false;
  const version = data.versions?.find((v) => v.version === published);
  if (!version?.createdAt || !data.workflow.updatedAt) return false;
  return new Date(data.workflow.updatedAt).getTime() > new Date(version.createdAt).getTime();
}

// ── Result formatting (pure over the mutation response) ──────────────────────

export type CommanderResult = { ok: boolean; headline: string; detail?: string; openHref?: string };

export function formatResult(action: CommanderAction, ok: boolean, body: Record<string, unknown> | null): CommanderResult {
  if (!ok) {
    const err = (body?.error as string) || 'The action could not be completed.';
    const reasons = Array.isArray(body?.reasons) ? ` (${(body!.reasons as string[]).join('; ')})` : '';
    return { ok: false, headline: 'Action failed', detail: `${err}${reasons}` };
  }
  switch (action.type) {
    case 'run_workflow': {
      const runId = body?.runId as string | undefined;
      return { ok: true, headline: 'Workflow started', detail: runId ? `Run ${runId}` : undefined, openHref: runId ? `/flows?run=${encodeURIComponent(runId)}` : undefined };
    }
    case 'publish_workflow':
      return { ok: true, headline: `Published v${body?.version ?? '?'}`, detail: 'The draft is now an immutable version.' };
    case 'delete_workflow':
      return { ok: true, headline: body?.mode === 'archived' ? 'Workflow archived' : 'Workflow deleted', detail: body?.mode === 'archived' ? 'History preserved.' : 'It had no history.' };
    case 'resolve_approval': {
      const already = body?.alreadyResolved === true;
      const verb = action.decision === 'approve' ? 'approved' : 'rejected';
      return { ok: true, headline: already ? 'Already resolved' : `Approval ${verb}`, detail: already ? 'No change — it was resolved earlier.' : 'The run has resumed.' };
    }
    case 'set_hermes_transport':
      return { ok: true, headline: `Switched to ${action.transport.toUpperCase()}`, detail: 'Production transport updated.' };
  }
}
