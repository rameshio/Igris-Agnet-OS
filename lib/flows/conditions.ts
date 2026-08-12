/**
 * Canonical condition schema + evaluator (Phase D).
 *
 * ONE evaluator is shared by Decision nodes and conditional edges (spec §16) —
 * there is never a second condition engine. No `eval`, no JS expressions: a
 * condition is a typed `{ left, operator, right? }` triple. `left` is a
 * reference/template; `right` is a literal (or a `{{ref}}`). Type handling is
 * strict — `equals` does NOT coerce (`"75" !== 75`, spec §12) — but the numeric
 * comparators perform an explicit, safe numeric conversion so a score stored as
 * a string still compares sensibly.
 */
import { z } from 'zod';
import { NodeExecError } from '@/lib/flows/errors';
import { resolveValue, tryResolveReference, stableStringify, type RefScope } from '@/lib/flows/references';

export const CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'exists',
  'not_exists',
  'is_true',
  'is_false',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Operators that ignore `right` and only inspect `left`. */
export const UNARY_OPERATORS: ReadonlySet<ConditionOperator> = new Set([
  'exists',
  'not_exists',
  'is_true',
  'is_false',
]);

export const ConditionSchema = z.object({
  /** A reference/template, e.g. `{{FitAssessor.data.fit_score}}`. */
  left: z.string().min(1),
  operator: z.enum(CONDITION_OPERATORS),
  /** Literal comparison value, or a `{{ref}}` string. Unused by unary operators. */
  right: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});
export type Condition = z.infer<typeof ConditionSchema>;

type Operand = { found: true; value: unknown } | { found: false };

/** Resolve one operand. `{{...}}` → reference (native type / found flag); plain scalars are literals. */
function resolveOperand(raw: string | number | boolean | null | undefined, scope: RefScope): Operand {
  if (typeof raw !== 'string') return { found: true, value: raw ?? null };
  const whole = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/.exec(raw);
  if (whole) {
    const outcome = tryResolveReference(whole[1], scope);
    return outcome.found ? { found: true, value: outcome.value } : { found: false };
  }
  if (raw.includes('{{')) return { found: true, value: resolveValue(raw, scope) };
  return { found: true, value: raw }; // literal string
}

/** Safe numeric conversion; throws `invalid_condition` when an operand is not numeric. */
function toNumber(value: unknown, op: ConditionOperator): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  throw new NodeExecError('invalid_condition', `Operator "${op}" requires numeric operands.`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return stableStringify(a) === stableStringify(b);
}

/** Evaluate a condition against the run scope. Throws normalized errors; never runs code. */
export function evaluateCondition(condition: Condition, scope: RefScope): boolean {
  const op = condition.operator;
  const left = resolveOperand(condition.left, scope);

  if (op === 'exists') return left.found;
  if (op === 'not_exists') return !left.found;

  if (!left.found) {
    throw new NodeExecError('workflow_reference_not_found', `Condition left operand "${condition.left}" could not be resolved.`);
  }
  const L = left.value;
  if (op === 'is_true') return L === true;
  if (op === 'is_false') return L === false;

  const right = resolveOperand(condition.right, scope);
  if (!right.found) {
    throw new NodeExecError('workflow_reference_not_found', `Condition right operand could not be resolved.`);
  }
  const R = right.value;

  switch (op) {
    case 'equals':
      return deepEqual(L, R);
    case 'not_equals':
      return !deepEqual(L, R);
    case 'greater_than':
      return toNumber(L, op) > toNumber(R, op);
    case 'greater_than_or_equal':
      return toNumber(L, op) >= toNumber(R, op);
    case 'less_than':
      return toNumber(L, op) < toNumber(R, op);
    case 'less_than_or_equal':
      return toNumber(L, op) <= toNumber(R, op);
    case 'contains':
      if (typeof L === 'string') return L.includes(String(R));
      if (Array.isArray(L)) return L.some((x) => deepEqual(x, R));
      throw new NodeExecError('invalid_condition', 'Operator "contains" requires a string or array left operand.');
    case 'not_contains':
      if (typeof L === 'string') return !L.includes(String(R));
      if (Array.isArray(L)) return !L.some((x) => deepEqual(x, R));
      throw new NodeExecError('invalid_condition', 'Operator "not_contains" requires a string or array left operand.');
    case 'starts_with':
      return typeof L === 'string' && L.startsWith(String(R));
    case 'ends_with':
      return typeof L === 'string' && L.endsWith(String(R));
    default: {
      const never: never = op;
      throw new NodeExecError('invalid_condition', `Unknown operator "${String(never)}".`);
    }
  }
}
