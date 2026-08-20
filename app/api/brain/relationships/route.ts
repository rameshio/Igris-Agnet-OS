/**
 * Create a typed relationship between two G-Brain entities (Architecture V2 · F3).
 * Idempotent on (from, to, type); endpoints + self-link + source are validated server-side.
 *   POST /api/brain/relationships   body: BrainRelationshipInput
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { createRelationship } from '@/lib/brain/core/relationships';
import { brainErrorInfo } from '@/lib/brain/core/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ relationship: createRelationship(getDb(), body) });
  } catch (err) {
    const { status, error } = brainErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
