import { describe, expect, test } from 'vitest';
import { validateWorkflowGraph } from '@/lib/flows/validator';

const input = (id: string) => ({ id, type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } });
const output = (id: string) => ({ id, type: 'output', x: 0, y: 0, config: { mode: 'display' } });
const has = (r: ReturnType<typeof validateWorkflowGraph>, code: string) => r.issues.some((i) => i.code === code);

describe('validator — Phase D checks', () => {
  test('unknown reference source in a transform is flagged', () => {
    const r = validateWorkflowGraph({
      nodes: [input('i'), { id: 't', type: 'transform', x: 0, y: 0, config: { mode: 'field', field: '{{ghost.data.x}}' } }, output('o')],
      edges: [{ id: 'e1', source: 'i', target: 't' }, { id: 'e2', source: 't', target: 'o' }],
    });
    expect(has(r, 'unknown_reference_source')).toBe(true);
  });

  test('a valid reference to an existing node passes', () => {
    const r = validateWorkflowGraph({
      nodes: [input('i'), { id: 't', type: 'transform', x: 0, y: 0, config: { mode: 'field', field: '{{i.text}}' } }, output('o')],
      edges: [{ id: 'e1', source: 'i', target: 't' }, { id: 'e2', source: 't', target: 'o' }],
    });
    expect(has(r, 'unknown_reference_source')).toBe(false);
    expect(has(r, 'invalid_reference')).toBe(false);
  });

  test('decision with no rules and no default route is flagged', () => {
    const r = validateWorkflowGraph({
      nodes: [input('i'), { id: 'd', type: 'decision', x: 0, y: 0, config: { rules: [] } }, output('o')],
      edges: [{ id: 'e1', source: 'i', target: 'd' }, { id: 'e2', source: 'd', target: 'o', sourceHandle: 'x' }],
    });
    expect(has(r, 'decision_no_routes')).toBe(true);
  });

  test('duplicate decision route names are flagged', () => {
    const r = validateWorkflowGraph({
      nodes: [
        input('i'),
        { id: 'd', type: 'decision', x: 0, y: 0, config: { rules: [
          { route: 'yes', condition: { left: '{{i.text}}', operator: 'equals', right: 'a' } },
          { route: 'yes', condition: { left: '{{i.text}}', operator: 'equals', right: 'b' } },
        ] } },
        output('o'),
      ],
      edges: [{ id: 'e1', source: 'i', target: 'd' }, { id: 'e2', source: 'd', target: 'o', sourceHandle: 'yes' }],
    });
    expect(has(r, 'duplicate_route')).toBe(true);
  });

  test('edge leaving a decision with an undeclared route handle is flagged', () => {
    const r = validateWorkflowGraph({
      nodes: [
        input('i'),
        { id: 'd', type: 'decision', x: 0, y: 0, config: { rules: [{ route: 'yes', condition: { left: '{{i.text}}', operator: 'exists' } }], defaultRoute: 'no' } },
        output('o'),
      ],
      edges: [{ id: 'e1', source: 'i', target: 'd' }, { id: 'e2', source: 'd', target: 'o', sourceHandle: 'maybe' }],
    });
    expect(has(r, 'unknown_route_handle')).toBe(true);
  });

  test('join with no incoming edges is flagged', () => {
    const r = validateWorkflowGraph({
      nodes: [input('i'), { id: 'j', type: 'join', x: 0, y: 0, config: {} }, output('o')],
      edges: [{ id: 'e1', source: 'i', target: 'o' }],
    });
    expect(has(r, 'join_no_inputs')).toBe(true);
  });

  test('invalid reference syntax (method call) is flagged', () => {
    const r = validateWorkflowGraph({
      nodes: [input('i'), { id: 't', type: 'transform', x: 0, y: 0, config: { mode: 'template', template: 'x {{i.text.toString()}}' } }, output('o')],
      edges: [{ id: 'e1', source: 'i', target: 't' }, { id: 'e2', source: 't', target: 'o' }],
    });
    expect(has(r, 'invalid_reference')).toBe(true);
  });

  test('edge object-mapping references are validated', () => {
    const r = validateWorkflowGraph({
      nodes: [input('i'), output('o')],
      edges: [{ id: 'e1', source: 'i', target: 'o', mapping: { mode: 'object', object: { a: '{{ghost.data.x}}' } } }],
    });
    expect(has(r, 'unknown_reference_source')).toBe(true);
  });
});
