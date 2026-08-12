import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveObjectMapping, resolveReference, type RefScope } from '@/lib/flows/references';
import { evaluateCondition } from '@/lib/flows/conditions';
import { errorMessageOf } from '@/lib/flows/errors';

describe('Phase D security', () => {
  test('the workflow-logic implementation contains no eval / Function / dynamic code', () => {
    const dir = path.join(process.cwd(), 'lib/flows');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(dir);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} must not use eval`).not.toMatch(/\beval\s*\(/);
      expect(src, `${f} must not construct functions dynamically`).not.toMatch(/\bnew\s+Function\b/);
    }
  });

  test('a reference cannot pollute Object.prototype', () => {
    const scope: RefScope = { a: { data: {} } };
    const malicious = JSON.parse('{"__proto__":"{{a.data}}"}') as Record<string, string>;
    expect(() => resolveObjectMapping(malicious, scope)).toThrow(/forbidden/i);
    // Object.prototype is untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('constructor / prototype traversal is blocked', () => {
    const scope: RefScope = { a: { data: { x: 1 } } };
    expect(() => resolveReference('a.constructor', scope)).toThrow(/forbidden/i);
    expect(() => resolveReference('a.data.__proto__', scope)).toThrow(/forbidden/i);
  });

  test('condition errors do not leak secret-shaped strings', () => {
    // errorMessageOf redacts credential-shaped substrings before surfacing.
    const scope: RefScope = { a: { data: { token: 'sk-abcdef1234567890secret' } } };
    try {
      // numeric comparison on a non-numeric value throws invalid_condition
      evaluateCondition({ left: '{{a.data.token}}', operator: 'greater_than', right: 5 }, scope);
      throw new Error('should have thrown');
    } catch (err) {
      const msg = errorMessageOf(err);
      expect(msg).not.toContain('sk-abcdef1234567890secret');
    }
  });
});
