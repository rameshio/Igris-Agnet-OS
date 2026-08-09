import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Department heads (2026-08-05) render in the /brain graph: a 'head'
 * kind with the Crown icon, sized between pillars and workers, a "Dept head"
 * legend chip, and pillar-layer placement in the neural strand view. The
 * radial graph is client-only (ssr:false) so this contract lives at source
 * level; the node/edge shape itself is covered in knowledge-graph.test.ts.
 */
describe('department heads render wiring', () => {
  test('KnowledgeGraph styles the head kind and shows it in the legend', () => {
    const src = read('components/KnowledgeGraph.tsx');
    expect(src).toContain("head: { color: 'var(--brain-2)', Icon: Crown");
    expect(src).toContain("label: 'Dept heads'");
    expect(src).toContain("{ label: 'Dept head', kind: 'head', color: CAT.head.color, Icon: CAT.head.Icon }");
    expect(src).toMatch(/import \{ Crown,/);
    // focus + hover treat a head as part of its pillar
    expect(src).toContain("n.id.replace('head:', 'team:')");
  });

  test('neural strand view places heads on the pillar layer', () => {
    expect(read('lib/neural-layout.ts')).toContain('head: 3');
  });
});
