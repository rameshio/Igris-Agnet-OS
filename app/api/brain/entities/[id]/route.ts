/**
 * One G-Brain entity (Architecture V2 · F3).
 *   GET /api/brain/entities/:id
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { getEntity } from '@/lib/brain/core/entities';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  const entity = getEntity(getDb(), params.id);
  if (!entity) return NextResponse.json({ error: 'entity not found' }, { status: 404 });
  return NextResponse.json({ entity });
}
