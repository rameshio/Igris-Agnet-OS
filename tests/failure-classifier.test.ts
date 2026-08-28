/**
 * Reliability G1 — the pure failure classifier + retry decision.
 * Maps existing error codes to a conservative taxonomy; decides retryability from
 * classification + attempt budget. No DB, no side effects.
 */
import { describe, expect, test } from 'vitest';
import { classifyFailure, decideRetry, isAutomaticallyRetryable } from '@/lib/company/manager/failure';

describe('classifyFailure — existing codes map to a conservative taxonomy', () => {
  test('transient/provider/timeout/rate-limit are auto-retryable', () => {
    for (const code of ['network_error', 'provider_unavailable', 'engine_error', 'interrupted']) {
      const c = classifyFailure(code);
      expect(c.retryable).toBe(true);
      expect(c.automaticRetryAllowed).toBe(true);
      expect(c.humanActionRequired).toBe(false);
    }
    expect(classifyFailure('rate_limited').class).toBe('PROVIDER_RATE_LIMIT');
    expect(classifyFailure('hermes_unavailable').class).toBe('PROVIDER_TIMEOUT');
    expect(classifyFailure('hermes_unavailable').automaticRetryAllowed).toBe(true);
  });

  test('missing config / auth / bad model are NOT retryable and need a human', () => {
    for (const code of ['credential_missing', 'provider_not_configured', 'provider_disabled', 'invalid_base_url', 'auth_failed', 'model_unavailable']) {
      const c = classifyFailure(code);
      expect(c.class).toBe('TOOL_CONFIGURATION_MISSING');
      expect(c.retryable).toBe(false);
      expect(c.automaticRetryAllowed).toBe(false);
      expect(c.humanActionRequired).toBe(true);
    }
  });

  test('capability/tool gap, invalid input, approval, permission are not retryable', () => {
    expect(classifyFailure('tool_gap').class).toBe('CAPABILITY_GAP');
    expect(classifyFailure('capability_gap').class).toBe('CAPABILITY_GAP');
    expect(classifyFailure('model_capability_mismatch').class).toBe('INVALID_INPUT');
    expect(classifyFailure('auto_not_implemented').class).toBe('INVALID_INPUT');
    expect(classifyFailure('hermes_approval_required').class).toBe('APPROVAL_REQUIRED');
    for (const code of ['tool_gap', 'model_capability_mismatch', 'hermes_approval_required']) {
      expect(classifyFailure(code).retryable).toBe(false);
    }
  });

  test('unknown / missing code is conservative UNKNOWN — no AUTOMATIC retry, but explicitRetryAllowed is true', () => {
    for (const code of [undefined, null, 'node_error', 'something_new']) {
      const c = classifyFailure(code);
      expect(c.class).toBe('UNKNOWN_RUNTIME_FAILURE');
      expect(c.automaticRetryAllowed).toBe(false); // never uncontrolled auto-retry
      expect(c.explicitRetryAllowed).toBe(true); // human operator may explicitly retry
      expect(c.retryable).toBe(true);
    }
  });
});

describe('decideRetry', () => {
  test('retryable with attempts remaining → RETRY_ALLOWED; exhausted → RETRY_EXHAUSTED', () => {
    const classification = classifyFailure('rate_limited');
    expect(decideRetry({ classification, attemptCount: 1, maxAttempts: 3 }).decision).toBe('RETRY_ALLOWED');
    expect(decideRetry({ classification, attemptCount: 3, maxAttempts: 3 }).decision).toBe('RETRY_EXHAUSTED');
    expect(decideRetry({ classification, attemptCount: 1, maxAttempts: 3 }).remainingAttempts).toBe(2);
  });

  test('UNKNOWN_RUNTIME_FAILURE allows explicit retry when budget remains, but exhausts at maxAttempts', () => {
    const classification = classifyFailure(undefined);
    expect(classification.class).toBe('UNKNOWN_RUNTIME_FAILURE');
    const decision = decideRetry({ classification, attemptCount: 1, maxAttempts: 3 });
    expect(decision.decision).toBe('RETRY_ALLOWED');
    expect(decision.automaticRetryAllowed).toBe(false);
    expect(decision.explicitRetryAllowed).toBe(true);

    const exhausted = decideRetry({ classification, attemptCount: 3, maxAttempts: 3 });
    expect(exhausted.decision).toBe('RETRY_EXHAUSTED');
  });

  test('non-retryable human-action → HUMAN_ACTION_REQUIRED', () => {
    expect(decideRetry({ classification: classifyFailure('credential_missing'), attemptCount: 1, maxAttempts: 3 }).decision).toBe('HUMAN_ACTION_REQUIRED');
    expect(decideRetry({ classification: classifyFailure('tool_gap'), attemptCount: 1, maxAttempts: 3 }).decision).toBe('HUMAN_ACTION_REQUIRED');
  });
});

describe('isAutomaticallyRetryable', () => {
  test('true only for auto classes with attempts remaining', () => {
    expect(isAutomaticallyRetryable({ classification: classifyFailure('hermes_unavailable'), attemptCount: 1, maxAttempts: 3 })).toBe(true);
    expect(isAutomaticallyRetryable({ classification: classifyFailure('hermes_unavailable'), attemptCount: 3, maxAttempts: 3 })).toBe(false);
    expect(isAutomaticallyRetryable({ classification: classifyFailure('credential_missing'), attemptCount: 0, maxAttempts: 3 })).toBe(false);
    expect(isAutomaticallyRetryable({ classification: classifyFailure(undefined), attemptCount: 0, maxAttempts: 3 })).toBe(false);
  });
});
