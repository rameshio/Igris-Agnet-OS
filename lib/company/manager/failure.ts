/**
 * Failure classification + retry decision (Reliability Phase G1) — PURE.
 *
 * ONE canonical classifier for company-task execution failures. It maps the
 * EXISTING machine-readable error codes (ModelRouteError codes from
 * `lib/models/router.ts`, NodeExecError codes, flow run codes) onto a small,
 * conservative taxonomy — it never invents a parallel error system, never
 * mutates state, and never retries. The company/manager layer owns the actual
 * retry (see `lib/company/manager/retry.ts`); this module only DECIDES.
 *
 * Design rules:
 *   - Retryable = a TRANSIENT provider/network/timeout/rate-limit condition.
 *   - A missing key/config, capability gap, permission/approval issue, or invalid
 *     input is NOT retryable — it needs a human, and must never burn attempts in a
 *     loop.
 *   - UNKNOWN is conservative: a human may retry it explicitly, but it is NEVER
 *     automatically retried.
 */

export type FailureClass =
  | 'TRANSIENT_PROVIDER_ERROR'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_TIMEOUT'
  | 'CONNECTOR_UNAVAILABLE'
  | 'TOOL_CONFIGURATION_MISSING'
  | 'CAPABILITY_GAP'
  | 'PERMISSION_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'INVALID_INPUT'
  | 'PERMANENT_TASK_FAILURE'
  // Reliability G2 — a running execution was interrupted by a process restart/crash.
  // Split by side-effect safety: EXECUTION_INTERRUPTED (idempotent → retryable like a
  // transient) vs INTERRUPTED_REVIEW_REQUIRED (a side effect MAY have completed → a human
  // must decide; never auto- or one-click-retried).
  | 'EXECUTION_INTERRUPTED'
  | 'INTERRUPTED_REVIEW_REQUIRED'
  | 'UNKNOWN_RUNTIME_FAILURE';

export type FailureClassification = {
  class: FailureClass;
  /** May this failure ever be retried (automatically OR by an explicit human action)? */
  retryable: boolean;
  /** May the Manager retry it WITHOUT a human, on the next bounded step? (subset of retryable) */
  automaticRetryAllowed: boolean;
  /** May an explicit human action retry it (when attempt budget remains)? */
  explicitRetryAllowed: boolean;
  /** Does resolving this require a human to change something (a key, a model, an input)? */
  humanActionRequired: boolean;
};

export type RetryDecisionKind =
  | 'RETRY_ALLOWED'
  | 'RETRY_EXHAUSTED'
  | 'HUMAN_ACTION_REQUIRED'
  | 'PERMANENT_FAILURE'
  | 'NOT_RETRYABLE';

export type RetryDecision = {
  decision: RetryDecisionKind;
  class: FailureClass;
  retryable: boolean;
  automaticRetryAllowed: boolean;
  explicitRetryAllowed: boolean;
  attemptCount: number;
  maxAttempts: number;
  remainingAttempts: number;
  reason: string;
};

// Static class table (the single source of truth for retry semantics).
const CLASS_TABLE: Record<FailureClass, Omit<FailureClassification, 'class'>> = {
  TRANSIENT_PROVIDER_ERROR: { retryable: true, automaticRetryAllowed: true, explicitRetryAllowed: true, humanActionRequired: false },
  PROVIDER_RATE_LIMIT: { retryable: true, automaticRetryAllowed: true, explicitRetryAllowed: true, humanActionRequired: false },
  PROVIDER_TIMEOUT: { retryable: true, automaticRetryAllowed: true, explicitRetryAllowed: true, humanActionRequired: false },
  CONNECTOR_UNAVAILABLE: { retryable: true, automaticRetryAllowed: true, explicitRetryAllowed: true, humanActionRequired: false },
  TOOL_CONFIGURATION_MISSING: { retryable: false, automaticRetryAllowed: false, explicitRetryAllowed: false, humanActionRequired: true },
  CAPABILITY_GAP: { retryable: false, automaticRetryAllowed: false, explicitRetryAllowed: false, humanActionRequired: true },
  PERMISSION_DENIED: { retryable: false, automaticRetryAllowed: false, explicitRetryAllowed: false, humanActionRequired: true },
  APPROVAL_REQUIRED: { retryable: false, automaticRetryAllowed: false, explicitRetryAllowed: false, humanActionRequired: true },
  INVALID_INPUT: { retryable: false, automaticRetryAllowed: false, explicitRetryAllowed: false, humanActionRequired: true },
  PERMANENT_TASK_FAILURE: { retryable: false, automaticRetryAllowed: false, explicitRetryAllowed: false, humanActionRequired: false },
  // G2: an interrupted execution of a side-effect-SAFE (idempotent) task behaves like a
  // transient failure — auto-retry is still additionally gated on `isTaskAutoRetrySafe`.
  EXECUTION_INTERRUPTED: { retryable: true, automaticRetryAllowed: true, explicitRetryAllowed: true, humanActionRequired: false },
  // G2: an interrupted execution whose completion cannot be proven and which MAY have
  // performed an external side effect — NEVER auto- or one-click-retried; a human decides.
  INTERRUPTED_REVIEW_REQUIRED: { retryable: false, automaticRetryAllowed: false, explicitRetryAllowed: false, humanActionRequired: true },
  // Conservative: a human MAY retry an unknown failure once, but the Manager NEVER
  // auto-retries it (no uncontrolled automatic retry loop).
  UNKNOWN_RUNTIME_FAILURE: { retryable: true, automaticRetryAllowed: false, explicitRetryAllowed: true, humanActionRequired: false },
};

// Existing error code → failure class. Codes come from lib/models/router.ts
// (ModelRouteError), lib/flows/errors.ts / coordinator.ts, and the dispatch layer.
const CODE_TO_CLASS: Record<string, FailureClass> = {
  // Transient — safe to auto-retry.
  network_error: 'TRANSIENT_PROVIDER_ERROR',
  provider_unavailable: 'CONNECTOR_UNAVAILABLE',
  engine_error: 'TRANSIENT_PROVIDER_ERROR',
  interrupted: 'TRANSIENT_PROVIDER_ERROR',
  rate_limited: 'PROVIDER_RATE_LIMIT',
  hermes_unavailable: 'PROVIDER_TIMEOUT',
  // Configuration / credential — human action, never auto-retry, never loop.
  credential_missing: 'TOOL_CONFIGURATION_MISSING',
  provider_not_configured: 'TOOL_CONFIGURATION_MISSING',
  provider_disabled: 'TOOL_CONFIGURATION_MISSING',
  invalid_base_url: 'TOOL_CONFIGURATION_MISSING',
  auth_failed: 'TOOL_CONFIGURATION_MISSING',
  model_unavailable: 'TOOL_CONFIGURATION_MISSING',
  tool_gap: 'CAPABILITY_GAP',
  capability_gap: 'CAPABILITY_GAP',
  // Invalid definition / selection — human must fix input/model.
  model_capability_mismatch: 'INVALID_INPUT',
  auto_not_implemented: 'INVALID_INPUT',
  workflow_reference_not_found: 'INVALID_INPUT',
  // Governance.
  hermes_approval_required: 'APPROVAL_REQUIRED',
  permission_denied: 'PERMISSION_DENIED',
  // G2 recovery — a process restart interrupted a running execution. The recovery service
  // chooses the code by side-effect safety (see lib/company/manager/recovery.ts).
  execution_interrupted: 'EXECUTION_INTERRUPTED',
  execution_interrupted_review: 'INTERRUPTED_REVIEW_REQUIRED',
};

/** Classify a failure from its machine-readable error code (missing/unknown ⇒ conservative UNKNOWN). */
export function classifyFailure(code?: string | null): FailureClassification {
  const cls = (code && CODE_TO_CLASS[code]) || 'UNKNOWN_RUNTIME_FAILURE';
  return { class: cls, ...CLASS_TABLE[cls] };
}

/** Decide whether a failed task may retry, given its classification + attempt budget. */
export function decideRetry(input: {
  classification: FailureClassification;
  attemptCount: number;
  maxAttempts: number;
}): RetryDecision {
  const { classification, attemptCount, maxAttempts } = input;
  const remainingAttempts = Math.max(0, maxAttempts - attemptCount);
  const base = {
    class: classification.class,
    retryable: classification.retryable,
    automaticRetryAllowed: classification.automaticRetryAllowed,
    explicitRetryAllowed: classification.explicitRetryAllowed,
    attemptCount,
    maxAttempts,
    remainingAttempts,
  };

  if (!classification.retryable) {
    if (classification.humanActionRequired)
      return { ...base, decision: 'HUMAN_ACTION_REQUIRED', reason: `${classification.class} — a human must resolve this before it can run` };
    if (classification.class === 'PERMANENT_TASK_FAILURE')
      return { ...base, decision: 'PERMANENT_FAILURE', reason: 'permanent failure — will not be retried' };
    return { ...base, decision: 'NOT_RETRYABLE', reason: `${classification.class} is not retryable` };
  }
  if (remainingAttempts <= 0)
    return { ...base, decision: 'RETRY_EXHAUSTED', reason: `retry budget exhausted (${attemptCount}/${maxAttempts})` };
  return { ...base, decision: 'RETRY_ALLOWED', reason: `retryable (${attemptCount}/${maxAttempts} attempts used)` };
}

/** The Manager's AUTOMATIC (no-human) retry gate — a strict subset of decideRetry. */
export function isAutomaticallyRetryable(input: {
  classification: FailureClassification;
  attemptCount: number;
  maxAttempts: number;
}): boolean {
  return input.classification.automaticRetryAllowed && input.attemptCount < input.maxAttempts;
}

// ── Reliability G4 — deterministic retry backoff (PURE, no clock, no randomness) ─────
//
// Backoff applies ONLY to genuinely TRANSIENT provider/connector conditions — the classes
// whose fix is "wait and try the SAME target again". It never widens the auto-retryable set.
// A process-restart interruption (EXECUTION_INTERRUPTED) is deliberately EXCLUDED: its recovery
// is manager-driven and should run on the next tick, not after a provider-style delay.

/** First-failure delay; doubles each subsequent attempt up to the cap. */
export const RETRY_BACKOFF_BASE_MS = 15_000;
/** Hard ceiling — this is local reliability backoff, not a job scheduler. */
export const RETRY_BACKOFF_MAX_MS = 60_000;

/** Transient classes that earn a wait-and-retry-same-target delay. */
export const BACKOFF_ELIGIBLE_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'TRANSIENT_PROVIDER_ERROR',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_TIMEOUT',
  'CONNECTOR_UNAVAILABLE',
]);

/**
 * Deterministic bounded exponential backoff (no jitter). `attemptCount` = attempts already
 * STARTED (so a task that just failed its first dispatch has attemptCount 1):
 *   attempt 1 → 15s · attempt 2 → 30s · attempt ≥3 → 60s (cap).
 * Returns 0 for any class that is NOT backoff-eligible, so the delay function alone encodes
 * the whole "does this failure get a scheduled delay?" policy.
 */
export function computeRetryDelayMs(input: {
  failureClass: FailureClass;
  attemptCount: number;
  maxAttempts: number;
}): number {
  if (!BACKOFF_ELIGIBLE_CLASSES.has(input.failureClass)) return 0;
  const n = Math.max(1, input.attemptCount);
  const delay = RETRY_BACKOFF_BASE_MS * 2 ** (n - 1);
  return Math.min(delay, RETRY_BACKOFF_MAX_MS);
}
