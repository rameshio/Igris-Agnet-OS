import { describe, expect, test } from 'vitest';
import { transformExecutor } from '@/lib/flows/executors/transform';
import type { NodeExecContext } from '@/lib/flows/registry';
import type { RefScope } from '@/lib/flows/references';

const scope: RefScope = {
  Analyzer: { text: 'ok', data: { job: { title: 'AI Engineer', company: 'Example' }, score: 82, skills: ['Python', 'RAG'], hire: true } },
};

function ctx(config: unknown): NodeExecContext {
  return {
    node: { id: 't', type: 'transform', x: 0, y: 0, config } as NodeExecContext['node'],
    input: { text: '' },
    state: {},
    scope,
    sources: [],
    startingInput: { text: '' },
    db: {} as NodeExecContext['db'],
    agents: [],
  };
}

describe('Transform executor (Phase D)', () => {
  test('field select', async () => {
    const r = await transformExecutor.execute!(ctx({ mode: 'field', field: '{{Analyzer.data.score}}' }));
    expect(r.output.data).toBe(82);
  });
  test('text template', async () => {
    const r = await transformExecutor.execute!(ctx({ mode: 'template', template: '{{Analyzer.data.job.company}} — Fit {{Analyzer.data.score}}' }));
    expect(r.output.text).toBe('Example — Fit 82');
  });
  test('object builder preserves types (array + number + boolean)', async () => {
    const r = await transformExecutor.execute!(
      ctx({ mode: 'object', object: { title: '{{Analyzer.data.job.title}}', company: '{{Analyzer.data.job.company}}', fitScore: '{{Analyzer.data.score}}', skills: '{{Analyzer.data.skills}}', hire: '{{Analyzer.data.hire}}' } }),
    );
    expect(r.output.data).toEqual({ title: 'AI Engineer', company: 'Example', fitScore: 82, skills: ['Python', 'RAG'], hire: true });
  });
  test('deterministic output for object mode (sorted keys)', async () => {
    const a = await transformExecutor.execute!(ctx({ mode: 'object', object: { b: '{{Analyzer.data.score}}', a: '1' } }));
    const b = await transformExecutor.execute!(ctx({ mode: 'object', object: { a: '1', b: '{{Analyzer.data.score}}' } }));
    expect(a.output.text).toBe(b.output.text);
  });
  test('missing reference fails (never silently empty)', async () => {
    await expect(transformExecutor.execute!(ctx({ mode: 'field', field: '{{Analyzer.data.ghost}}' }))).rejects.toThrow(/could not be resolved/i);
  });
  test('multiple upstream sources referenced in one object', async () => {
    const s2: RefScope = { A: { data: { x: 1 } }, B: { data: { y: 2 } } };
    const c = ctx({ mode: 'object', object: { x: '{{A.data.x}}', y: '{{B.data.y}}' } });
    (c as { scope: RefScope }).scope = s2;
    const r = await transformExecutor.execute!(c);
    expect(r.output.data).toEqual({ x: 1, y: 2 });
  });
});
