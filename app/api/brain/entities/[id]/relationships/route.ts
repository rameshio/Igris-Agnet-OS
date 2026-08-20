/**
 * An entity's neighborhood (Architecture V2 · F3) — its edges (both directions) + safe
 * neighbor entities. This is the read seam a future F4 Radial view consumes; F3 builds no
 * Radial interaction.
 *   GET /api/brain/entities/:id/relationships
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { neighborhood } from '@/lib/brain/core/relationships';
import { brainErrorInfo } from '@/lib/brain/core/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    return NextResponse.json(neighborhood(getDb(), params.id));
  } catch (err) {
    const { status, error } = brainErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
