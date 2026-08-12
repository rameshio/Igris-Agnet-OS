import { describe, expect, test } from 'vitest';
import { evaluateCondition, ConditionSchema, type Condition } from '@/lib/flows/conditions';
import type { RefScope } from '@/lib/flows/references';

const scope: RefScope = {
  A: { text: 'hello world', data: { score: 82, ratio: 0.9, flag: true, off: false, skills: ['Python', 'RAG'], name: 'Ada', scoreStr: '82' } },
};
const cond = (left: string, operator: Condition['operator'], right?: Condition['right']): Condition =>
  ConditionSchema.parse({ left, operator, right });

describe('condition evaluator (Phase D)', () => {
  test('equals is strict — "82" (string) does not equal 82 (number)', () => {
    expect(evaluateCondition(cond('{{A.data.score}}', 'equals', 82), scope)).toBe(true);
    expect(evaluateCondition(cond('{{A.data.scoreStr}}', 'equals', 82), scope)).toBe(false);
    expect(evaluateCondition(cond('{{A.data.name}}', 'equals', 'Ada'), scope)).toBe(true);
  });
  test('not_equals', () => {
    expect(evaluateCondition(cond('{{A.data.name}}', 'not_equals', 'Bob'), scope)).toBe(true);
  });
  test('greater_than / greater_than_or_equal', () => {
    expect(evaluateCondition(cond('{{A.data.score}}', 'greater_than', 75), scope)).toBe(true);
    expect(evaluateCondition(cond('{{A.data.score}}', 'greater_than_or_equal', 82), scope)).toBe(true);
    expect(evaluateCondition(cond('{{A.data.score}}', 'greater_than', 90), scope)).toBe(false);
  });
  test('less_than / less_than_or_equal', () => {
    expect(evaluateCondition(cond('{{A.data.score}}', 'less_than', 90), scope)).toBe(true);
    expect(evaluateCondition(cond('{{A.data.score}}', 'less_than_or_equal', 82), scope)).toBe(true);
  });
  test('numeric operators apply safe numeric conversion to numeric strings', () => {
    expect(evaluateCondition(cond('{{A.data.scoreStr}}', 'greater_than_or_equal', 75), scope)).toBe(true);
  });
  test('numeric operator on a non-numeric value throws invalid_condition', () => {
    expect(() => evaluateCondition(cond('{{A.data.name}}', 'greater_than', 5), scope)).toThrow(/numeric/i);
  });
  test('contains / not_contains on strings and arrays', () => {
    expect(evaluateCondition(cond('{{A.text}}', 'contains', 'world'), scope)).toBe(true);
    expect(evaluateCondition(cond('{{A.data.skills}}', 'contains', 'RAG'), scope)).toBe(true);
    expect(evaluateCondition(cond('{{A.data.skills}}', 'not_contains', 'Go'), scope)).toBe(true);
  });
  test('starts_with / ends_with', () => {
    expect(evaluateCondition(cond('{{A.text}}', 'starts_with', 'hello'), scope)).toBe(true);
    expect(evaluateCondition(cond('{{A.text}}', 'ends_with', 'world'), scope)).toBe(true);
  });
  test('exists / not_exists', () => {
    expect(evaluateCondition(cond('{{A.data.score}}', 'exists'), scope)).toBe(true);
    expect(evaluateCondition(cond('{{A.data.ghost}}', 'exists'), scope)).toBe(false);
    expect(evaluateCondition(cond('{{A.data.ghost}}', 'not_exists'), scope)).toBe(true);
  });
  test('is_true / is_false are strict booleans', () => {
    expect(evaluateCondition(cond('{{A.data.flag}}', 'is_true'), scope)).toBe(true);
    expect(evaluateCondition(cond('{{A.data.off}}', 'is_false'), scope)).toBe(true);
    expect(evaluateCondition(cond('{{A.data.score}}', 'is_true'), scope)).toBe(false);
  });
  test('a missing reference in a binary condition throws workflow_reference_not_found (fails safely, no leak)', () => {
    expect(() => evaluateCondition(cond('{{A.data.ghost}}', 'greater_than', 5), scope)).toThrow(/could not be resolved/i);
  });
  test('right operand may itself be a reference', () => {
    const s: RefScope = { A: { data: { score: 82 } }, B: { data: { threshold: 75 } } };
    expect(evaluateCondition(cond('{{A.data.score}}', 'greater_than', '{{B.data.threshold}}'), s)).toBe(true);
  });
  test('invalid operator rejected by the schema', () => {
    expect(() => ConditionSchema.parse({ left: '{{A.text}}', operator: 'regex_match', right: 'x' })).toThrow();
  });
});
