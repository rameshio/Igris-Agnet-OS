/**
 * G-Brain Core sources / provenance (Architecture V2 · F3). List + explicit create.
 * Sources never store credentials/auth — a plain resource URL + safe labels only.
 *   GET  /api/brain/sources
 *   POST /api/brain/sources   body: BrainSourceInput
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { createSource, listSources } from '@/lib/brain/core/sources';
import { brainErrorInfo } from '@/lib/brain/core/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return NextResponse.json({ sources: listSources(getDb()) });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ source: createSource(getDb(), body) });
  } catch (err) {
    const { status, error } = brainErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
