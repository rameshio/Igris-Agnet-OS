/**
 * Canonical workflow reference + template resolver (Phase D).
 *
 * ONE place parses `{{Node.field}}` references. Decision conditions, edge
 * mappings, and Transform configs all resolve through here — executors never
 * parse `{{...}}` themselves (spec §4). Read-only, deterministic, and safe:
 *
 *  - property/path lookup only — never `eval`, function calls, or code (spec §5).
 *  - dangerous keys (`__proto__`, `prototype`, `constructor`) are rejected so a
 *    reference can never walk the prototype chain (spec §50).
 *  - a missing reference throws `workflow_reference_not_found` — it is NEVER
 *    silently replaced with an empty string (spec §6).
 *
 * Resolution scope is keyed by node id (and, when unambiguous, node label). The
 * root of a reference is a NodeOutput `{ text?, data? }`; the remaining path is
 * walked against it, so `{{A.text}}` and `{{A.data.person.name}}` both work.
 */
import { NodeExecError } from '@/lib/flows/errors';
import type { NodeOutput } from '@/lib/flows/run-types';

/** Reference resolution scope: reference root → that node's output. */
export type RefScope = Record<string, NodeOutput | undefined>;

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
/** A path segment: identifier or array index. Parens/brackets/methods are rejected. */
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
/** One `{{ ... }}` reference (non-greedy, no nested braces). */
const REF_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
/** The whole string is exactly one reference (→ preserve the value's native type). */
const WHOLE_REF_RE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;

/** Deterministic JSON: object keys sorted, so serialization never depends on insertion order (spec §53/§66). */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = walk((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/** Render a resolved value as text for string interpolation (objects/arrays → deterministic JSON). */
export function stringifyValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return stableStringify(value);
}

/** One own-property/index step. Read-only; returns `undefined` for a miss (never throws for a missing key). */
function indexInto(obj: unknown, key: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    if (!/^\d+$/.test(key)) return undefined;
    return obj[Number(key)];
  }
  if (typeof obj !== 'object') return undefined;
  // Own enumerable/!inherited only — blocks prototype-chain traversal.
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

export type ResolveOutcome = { found: true; value: unknown } | { found: false; missing: string; root: string };

/** Parse + walk a bare reference (`Node.data.x`), never throwing. Use for `exists`/optional checks. */
export function tryResolveReference(ref: string, scope: RefScope): ResolveOutcome {
  const segments = ref.split('.').map((s) => s.trim());
  if (segments.length === 0 || segments.some((s) => s.length === 0 || !SEGMENT_RE.test(s))) {
    throw new NodeExecError('invalid_reference', `Reference "${ref}" is not a valid property path.`);
  }
  for (const seg of segments) {
    if (DANGEROUS_KEYS.has(seg)) throw new NodeExecError('unsafe_reference', `Reference "${ref}" uses a forbidden key.`);
  }
  const root = segments[0];
  if (!(root in scope) || scope[root] === undefined) {
    return { found: false, missing: root, root };
  }
  let cur: unknown = scope[root];
  for (const key of segments.slice(1)) {
    cur = indexInto(cur, key);
    if (cur === undefined) return { found: false, missing: ref, root };
  }
  return { found: true, value: cur };
}

/** Resolve a bare reference, throwing `workflow_reference_not_found` on a miss (spec §6). */
export function resolveReference(ref: string, scope: RefScope): unknown {
  const outcome = tryResolveReference(ref, scope);
  if (!outcome.found) {
    throw new NodeExecError(
      'workflow_reference_not_found',
      `Reference "{{${ref.trim()}}}" could not be resolved (missing "${outcome.missing}").`,
    );
  }
  return outcome.value;
}

/**
 * Resolve a template/value:
 *  - a whole-string reference (`"{{A.data.skills}}"`) returns the value with its
 *    native type preserved (array stays an array — spec §49).
 *  - anything with surrounding text (`"Skills: {{A.data.skills}}"`) is
 *    interpolated to a string, with objects/arrays serialized deterministically.
 *  - a literal with no `{{...}}` is returned unchanged (static value).
 * One pass — substituted text is never re-evaluated (spec §51).
 */
export function resolveValue(template: string, scope: RefScope): unknown {
  const whole = WHOLE_REF_RE.exec(template);
  if (whole) return resolveReference(whole[1], scope);
  if (!template.includes('{{')) return template; // static literal
  return template.replace(REF_RE, (_m, inner: string) => stringifyValue(resolveReference(inner, scope)));
}

/** Resolve `field`-mode mapping: a single reference. Accepts `{{A.data.x}}` or bare `A.data.x`. */
export function resolveField(field: string, scope: RefScope): unknown {
  const trimmed = field.trim();
  if (trimmed.includes('{{')) return resolveValue(trimmed, scope);
  return resolveReference(trimmed, scope);
}

/**
 * Build the reference scope for a run: succeeded nodes keyed by id, plus a label
 * alias when that label is unique and does not collide with a node id (spec §4).
 */
export function buildScope(nodes: { id: string; label?: string }[], state: Record<string, NodeOutput>): RefScope {
  const scope: RefScope = {};
  for (const n of nodes) if (state[n.id] !== undefined) scope[n.id] = state[n.id];

  const labelCounts = new Map<string, number>();
  for (const n of nodes) if (n.label) labelCounts.set(n.label, (labelCounts.get(n.label) ?? 0) + 1);
  const idSet = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    if (n.label && labelCounts.get(n.label) === 1 && !idSet.has(n.label) && state[n.id] !== undefined) {
      scope[n.label] = state[n.id];
    }
  }
  return scope;
}

/**
 * Extract the root reference names from a template, for STATIC validation at
 * publish time (spec §35). Reports syntactically-invalid references separately.
 * Only the root (first segment) can be checked statically — deeper paths depend
 * on runtime values and are NOT validated here.
 */
export function extractReferenceRoots(template: string): { roots: string[]; invalid: string[] } {
  const roots: string[] = [];
  const invalid: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(REF_RE.source, 'g');
  while ((m = re.exec(template)) !== null) {
    const ref = m[1].trim();
    const segments = ref.split('.').map((s) => s.trim());
    if (segments.length === 0 || segments.some((s) => s.length === 0 || !SEGMENT_RE.test(s))) {
      invalid.push(ref);
      continue;
    }
    if (segments.some((s) => DANGEROUS_KEYS.has(s))) {
      invalid.push(ref);
      continue;
    }
    roots.push(segments[0]);
  }
  return { roots, invalid };
}

/** Resolve an object map (`{ key: "{{ref}}" }`) → a resolved object, values type-preserved when whole-refs. */
export function resolveObjectMapping(map: Record<string, string>, scope: RefScope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(map)) {
    if (DANGEROUS_KEYS.has(key)) throw new NodeExecError('unsafe_reference', `Mapping key "${key}" is forbidden.`);
    out[key] = resolveValue(map[key], scope);
  }
  return out;
}
