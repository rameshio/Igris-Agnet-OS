/**
 * G-Brain Radial projection (Architecture V2 · F4). Bounded, read-only structural
 * neighborhood around a root entity. Combines PROJECTED canonical edges with PERSISTED
 * G-Brain edges; never writes. No `entity` param → an empty graph (nothing selected).
 *   GET /api/brain/radial?entity=<ref|id>&depth=1&limit=100
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { getRadialNeighborhood } from '@/lib/brain/projection/radial';
import { brainErrorInfo } from '@/lib/brain/core/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: Request) {
  const url = new URL(req.url);
  const entity = url.searchParams.get('entity');
  if (!entity) return NextResponse.json({ root: null, nodes: [], edges: [], truncated: false });
  try {
    const depth = Number(url.searchParams.get('depth')) || undefined;
    const limit = Number(url.searchParams.get('limit')) || undefined;
    return NextResponse.json(getRadialNeighborhood(getDb(), { entity, depth, limit }));
  } catch (err) {
    const { status, error } = brainErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
