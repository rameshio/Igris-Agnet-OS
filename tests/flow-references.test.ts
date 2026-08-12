import { describe, expect, test } from 'vitest';
import {
  resolveReference,
  resolveValue,
  resolveField,
  resolveObjectMapping,
  tryResolveReference,
  stableStringify,
  stringifyValue,
  type RefScope,
} from '@/lib/flows/references';

const scope: RefScope = {
  Analyzer: {
    text: 'Candidate appears suitable.',
    data: { fit_score: 82, hire: true, skills: ['Python', 'RAG'], person: { name: 'Ada' }, note: null },
  },
  Empty: { text: '' },
};

describe('reference resolver (Phase D)', () => {
  test('resolves .text', () => {
    expect(resolveReference('Analyzer.text', scope)).toBe('Candidate appears suitable.');
  });
  test('resolves a nested data field', () => {
    expect(resolveReference('Analyzer.data.person.name', scope)).toBe('Ada');
  });
  test('resolves a numeric field with its number type', () => {
    expect(resolveReference('Analyzer.data.fit_score', scope)).toBe(82);
  });
  test('resolves a boolean field with its boolean type', () => {
    expect(resolveReference('Analyzer.data.hire', scope)).toBe(true);
  });
  test('resolves an array and preserves its type', () => {
    expect(resolveReference('Analyzer.data.skills', scope)).toEqual(['Python', 'RAG']);
  });
  test('resolves an array index', () => {
    expect(resolveReference('Analyzer.data.skills.0', scope)).toBe('Python');
  });

  test('a whole-string reference preserves the native type (array stays an array)', () => {
    expect(resolveValue('{{Analyzer.data.skills}}', scope)).toEqual(['Python', 'RAG']);
    expect(resolveValue('{{Analyzer.data.fit_score}}', scope)).toBe(82);
  });
  test('an inline reference stringifies (objects/arrays → JSON)', () => {
    expect(resolveValue('Skills: {{Analyzer.data.skills}}', scope)).toBe('Skills: ["Python","RAG"]');
  });
  test('multiple references in one template', () => {
    expect(resolveValue('{{Analyzer.data.person.name}} scored {{Analyzer.data.fit_score}}', scope)).toBe('Ada scored 82');
  });
  test('a literal with no references is returned unchanged (static value)', () => {
    expect(resolveValue('just text', scope)).toBe('just text');
  });

  test('missing source node throws workflow_reference_not_found', () => {
    expect(() => resolveReference('Ghost.text', scope)).toThrowError(/workflow_reference_not_found|could not be resolved/i);
    expect(tryResolveReference('Ghost.text', scope).found).toBe(false);
  });
  test('missing property throws workflow_reference_not_found', () => {
    expect(() => resolveReference('Analyzer.data.nope', scope)).toThrow(/could not be resolved/i);
    expect(tryResolveReference('Analyzer.data.nope', scope).found).toBe(false);
  });
  test('a present null value is found (not treated as missing)', () => {
    expect(tryResolveReference('Analyzer.data.note', scope).found).toBe(true);
  });
  test('invalid syntax (method call) is rejected', () => {
    expect(() => resolveReference('Analyzer.data.skills.toString()', scope)).toThrow(/valid property path/i);
  });

  test('dangerous __proto__ is blocked', () => {
    expect(() => resolveReference('Analyzer.__proto__', scope)).toThrow(/forbidden key/i);
  });
  test('dangerous constructor is blocked', () => {
    expect(() => resolveReference('Analyzer.data.constructor', scope)).toThrow(/forbidden key/i);
  });
  test('object mapping rejects a dangerous key (as it arrives from persisted JSON)', () => {
    // JSON.parse makes "__proto__" a real own property (an object literal would not).
    const malicious = JSON.parse('{"__proto__":"{{Analyzer.text}}"}') as Record<string, string>;
    expect(() => resolveObjectMapping(malicious, scope)).toThrow(/forbidden/i);
  });

  test('no recursive expansion — a resolved value that looks like a reference is not re-resolved', () => {
    const s: RefScope = { A: { text: '{{B.text}}' }, B: { text: 'SECRET' } };
    expect(resolveValue('{{A.text}}', s)).toBe('{{B.text}}');
    expect(resolveValue('wrap {{A.text}} end', s)).toBe('wrap {{B.text}} end');
  });

  test('deterministic object serialization (keys sorted, insertion order irrelevant)', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
    expect(stringifyValue({ z: [3, 2], a: 1 })).toBe('{"a":1,"z":[3,2]}');
  });

  test('resolveField accepts bare and braced references, type-preserved', () => {
    expect(resolveField('Analyzer.data.skills', scope)).toEqual(['Python', 'RAG']);
    expect(resolveField('{{Analyzer.data.fit_score}}', scope)).toBe(82);
  });

  test('object mapping preserves primitive/object types on whole-reference values (spec §49)', () => {
    const out = resolveObjectMapping({ skills: '{{Analyzer.data.skills}}', score: '{{Analyzer.data.fit_score}}', label: 'Fit: {{Analyzer.data.fit_score}}' }, scope);
    expect(out.skills).toEqual(['Python', 'RAG']);
    expect(out.score).toBe(82);
    expect(out.label).toBe('Fit: 82');
  });
});
