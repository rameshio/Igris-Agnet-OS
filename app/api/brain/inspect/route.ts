/**
 * Universal Inspector (Architecture V2 · F4). Resolves one canonical object into a safe,
 * typed view with CLOSED actions. Read-only — mutating actions route through existing APIs.
 *   GET /api/brain/inspect?kind=<agent|mission|task|artifact|knowledge|workflow|source|approval>&id=<id>
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { inspectEntity } from '@/lib/brain/inspector/service';
import { brainErrorInfo } from '@/lib/brain/core/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') ?? '';
  const id = url.searchParams.get('id') ?? '';
  try {
    return NextResponse.json({ view: inspectEntity(getDb(), { kind, id }) });
  } catch (err) {
    const { status, error } = brainErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
