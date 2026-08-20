/**
 * Consolidated G-Brain graph (Architecture V2 · G-Brain consolidation). ONE brain, two
 * projections rendered by the original attractive radial/neural renderers:
 *   mode=structural  → company → missions → tasks → agents → artifacts/knowledge (F4-canonical)
 *   mode=operational → the read-only F5 live/recent operational projection, remapped to KGData
 * No `entity` → a bounded company-wide overview (never blank). Read-only; no mutation endpoint.
 *   GET /api/brain/company-graph?entity=<ref>&mode=structural|operational&window=15m|1h|6h|24h
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { parseEntityRef } from '@/lib/brain/projection/model';
import { buildStructuralBrainGraph, buildOperationalBrainGraph } from '@/lib/brain/company-brain-graph';
import { brainErrorInfo, BrainError } from '@/lib/brain/core/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: Request) {
  const url = new URL(req.url);
  try {
    const entityParam = url.searchParams.get('entity');
    const focus = entityParam ? parseEntityRef(entityParam) : null;
    if (entityParam && !focus) throw new BrainError('invalid entity reference', 400);

    const mode = url.searchParams.get('mode') === 'operational' ? 'operational' : 'structural';
    const window = url.searchParams.get('window') ?? undefined;

    const result =
      mode === 'operational'
        ? buildOperationalBrainGraph(getDb(), { window, focus })
        : buildStructuralBrainGraph(getDb(), { focus });
    return NextResponse.json(result);
  } catch (err) {
    const { status, error } = brainErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
