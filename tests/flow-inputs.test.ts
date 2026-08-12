import { describe, expect, test } from 'vitest';
import { resolveNodeInputs } from '@/lib/flows/inputs';
import { WorkflowEdgeSchema, type WorkflowEdge } from '@/lib/flows/schema';
import type { RefScope } from '@/lib/flows/references';

const E = (o: Partial<WorkflowEdge> & { id: string; source: string; target: string }): WorkflowEdge =>
  WorkflowEdgeSchema.parse(o);

const scope: RefScope = {
  a: { text: 'AAA', data: { score: 82, skills: ['Python', 'RAG'] } },
  b: { text: 'BBB', data: { company: 'Example' } },
};

describe('resolveNodeInputs (edge mapping, Phase D)', () => {
  test('no active edges → the run starting input (root node)', () => {
    const { input } = resolveNodeInputs([], scope, { text: 'seed' });
    expect(input.text).toBe('seed');
  });

  test('single all-mapping edge passes the source text through (Phase C parity)', () => {
    const { input } = resolveNodeInputs([E({ id: 'e', source: 'a', target: 't' })], scope, { text: '' });
    expect(input.text).toBe('AAA');
    expect(input.data).toEqual({ score: 82, skills: ['Python', 'RAG'] });
  });

  test('field mapping resolves a single reference, type-preserved', () => {
    const edge = E({ id: 'e', source: 'a', target: 't', mapping: { mode: 'field', field: '{{a.data.skills}}' } });
    const { input } = resolveNodeInputs([edge], scope, { text: '' });
    expect(input.data).toEqual(['Python', 'RAG']);
  });

  test('template mapping produces interpolated text', () => {
    const edge = E({ id: 'e', source: 'a', target: 't', mapping: { mode: 'template', template: 'Score: {{a.data.score}}' } });
    const { input } = resolveNodeInputs([edge], scope, { text: '' });
    expect(input.text).toBe('Score: 82');
  });

  test('object mapping builds a structured object, preserving primitive/array types', () => {
    const edge = E({
      id: 'e',
      source: 'a',
      target: 't',
      mapping: { mode: 'object', object: { s: '{{a.data.score}}', k: '{{a.data.skills}}' } },
    });
    const { input } = resolveNodeInputs([edge], scope, { text: '' });
    expect(input.data).toEqual({ s: 82, k: ['Python', 'RAG'] });
  });

  test('multiple predecessors merge deterministically sorted by source id', () => {
    const edges = [E({ id: 'e2', source: 'b', target: 't' }), E({ id: 'e1', source: 'a', target: 't' })];
    const { input, sources } = resolveNodeInputs(edges, scope, { text: '' });
    expect(input.text).toBe('AAA\n\nBBB'); // a before b regardless of edge order
    expect(sources.map((s) => s.nodeId)).toEqual(['a', 'b']);
  });

  test('sources retain branch labels (targetHandle) for Join keying', () => {
    const edges = [
      E({ id: 'e1', source: 'a', target: 'j', targetHandle: 'resume' }),
      E({ id: 'e2', source: 'b', target: 'j', targetHandle: 'cover' }),
    ];
    const { sources } = resolveNodeInputs(edges, scope, { text: '' });
    expect(sources.find((s) => s.nodeId === 'a')?.handle).toBe('resume');
    expect(sources.find((s) => s.nodeId === 'b')?.handle).toBe('cover');
  });

  test('a missing reference in a field mapping throws (never silently empty)', () => {
    const edge = E({ id: 'e', source: 'a', target: 't', mapping: { mode: 'field', field: '{{a.data.ghost}}' } });
    expect(() => resolveNodeInputs([edge], scope, { text: '' })).toThrow(/could not be resolved/i);
  });
});
