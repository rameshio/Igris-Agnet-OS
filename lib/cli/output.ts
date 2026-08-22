/**
 * IGRIS CLI output — human-readable by default, `--json` for automation, with a
 * defensive secret-redaction pass on everything printed (the server never returns a
 * secret, but the CLI redacts anyway as belt-and-suspenders). No ANSI explosion:
 * colour is opt-in and degrades to plain text.
 */
export type Io = { out: (s: string) => void; err: (s: string) => void };

/** Capture-friendly IO for tests: collects lines and exposes them joined. */
export function makeBufferIo(): Io & { stdout: string[]; stderr: string[]; text: () => string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    text: () => stdout.join('\n'),
  };
}

// Patterns that look like credentials — masked before printing.
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, // OpenAI/Stripe-style keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, // Anthropic
  /\bAIza[A-Za-z0-9_-]{20,}\b/g, // Google API keys
  /\btvly-[A-Za-z0-9_-]{10,}\b/g, // Tavily
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
  /\b[A-Za-z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)\s*[=:]\s*\S+/gi,
];

/** Mask anything that looks like a secret. Safe to run over all output. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, (m) => {
    const eq = m.search(/[=:]/);
    return eq > 0 ? `${m.slice(0, eq + 1)} [redacted]` : '[redacted]';
  }), text);
}

/** Print either the JSON payload or the human lines, redacted. */
export function emit(io: Io, opts: { json: boolean }, human: string, data: unknown): void {
  const text = opts.json ? JSON.stringify(data, null, 2) : human;
  io.out(redactSecrets(text));
}

/** Two-column aligned table (header + rows). Plain text, no borders. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** Simple key/value block for a single record. */
export function kv(pairs: [string, string | number | null | undefined][]): string {
  const w = Math.max(0, ...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${k.padEnd(w)}  ${v ?? '—'}`).join('\n');
}

/**
 * Render a value for HUMAN output. A canonical reference object `{ kind, id }` becomes a
 * readable `kind:id` (never `[object Object]`); other objects fall back to compact JSON;
 * scalars stringify. JSON output uses the raw value untouched (structured), never this.
 */
export function formatRefValue(v: unknown): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.kind === 'string' && typeof o.id === 'string') return `${o.kind}:${o.id}`;
    return JSON.stringify(v);
  }
  return v === null || v === undefined ? '—' : String(v);
}
