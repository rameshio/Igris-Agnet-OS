/**
 * Archive a mission (Architecture V2 · consolidation) — lifecycle-safe: set status
 * `archived` (hidden from the default view), keeping ALL tasks/artifacts/events/knowledge
 * and provenance intact. Preferred over deletion when history/audit matters.
 *   POST /api/missions/:id/archive
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { archiveMission } from '@/lib/company/cleanup/service';
import { companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    return NextResponse.json({ mission: archiveMission(getDb(), params.id) });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
