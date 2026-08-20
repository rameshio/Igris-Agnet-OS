/**
 * G-Brain Core entities (Architecture V2 · F3). List (optionally by ?type=) + create.
 * Canonical refs are validated against their owning system; state is never copied.
 *   GET  /api/brain/entities[?type=concept]
 *   POST /api/brain/entities   body: BrainEntityInput
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { createEntity, listEntities } from '@/lib/brain/core/entities';
import { brainErrorInfo } from '@/lib/brain/core/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: Request) {
  const type = new URL(req.url).searchParams.get('type')?.trim() || undefined;
  return NextResponse.json({ entities: listEntities(getDb(), type) });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ entity: createEntity(getDb(), body) });
  } catch (err) {
    const { status, error } = brainErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
