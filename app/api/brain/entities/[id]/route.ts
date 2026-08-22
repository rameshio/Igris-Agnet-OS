/**
 * One G-Brain entity (Architecture V2 · F3).
 *   GET /api/brain/entities/:id
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { getEntity } from '@/lib/brain/core/entities';
import { canonicalRefState } from '@/lib/brain/core/provenance';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  const entity = getEntity(db, params.id);
  if (!entity) return NextResponse.json({ error: 'entity not found' }, { status: 404 });
  // Additive, honest resolution state for a canonical ref: 'live' if the owning object
  // still exists, 'missing' if it was deleted while G-Brain provenance persists. The
  // `entity` object (incl. its structured `canonicalRef`) is unchanged.
  const canonicalState = entity.canonicalRef ? canonicalRefState(db, entity.canonicalRef) : undefined;
  return NextResponse.json({ entity, ...(canonicalState ? { canonicalState } : {}) });
}
