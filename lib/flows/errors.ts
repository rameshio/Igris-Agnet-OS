/**
 * Node-execution errors + safe extraction helpers (Phase C). Both
 * ModelRouteError (Phase B) and NodeExecError carry a string `code`, so the
 * engine can persist a normalized `error_code` without knowing the source.
 */
export class NodeExecError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NodeExecError';
  }
}

export function errorCodeOf(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return 'node_error';
}

/** Redact anything credential-shaped before persisting/surfacing an error. */
export function redactSecret(msg: string): string {
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(sk|nvapi|AIza)[A-Za-z0-9._-]{6,}/g, '[redacted-key]')
    .slice(0, 500);
}

export function errorMessageOf(err: unknown): string {
  return redactSecret(err instanceof Error ? err.message : String(err));
}
