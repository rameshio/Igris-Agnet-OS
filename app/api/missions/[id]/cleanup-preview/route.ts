/**
 * Mission cleanup PREVIEW (Architecture V2 · consolidation) — read-only U3 preview of
 * exactly what a delete would remove (mission-owned records) vs preserve (shared agents,
 * workflows, durable knowledge). Never mutates.
 *   GET /api/missions/:id/cleanup-preview
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { previewMissionCleanup } from '@/lib/company/cleanup/service';
import { companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    return NextResponse.json(previewMissionCleanup(getDb(), params.id));
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
