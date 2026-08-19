/**
 * One company artifact (Architecture V2 · F1) — the full structured work product,
 * traceable to its mission/task/execution. This single-item read may include the
 * full `content`; broad summary feeds (report/events) use the SAFE projection only.
 *   GET /api/company-artifacts/:id
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { getArtifact } from '@/lib/company/manager/artifacts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  const artifact = getArtifact(getDb(), params.id);
  if (!artifact) return NextResponse.json({ error: 'artifact not found' }, { status: 404 });
  return NextResponse.json({ artifact });
}
