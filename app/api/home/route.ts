/**
 * GET /api/home (UX Foundation U6) — the Commander Home snapshot. One read-only,
 * bounded projection that composes the existing U4/U5 services + repos (see
 * lib/home/service.ts). No mutation, no new table; Home polls this single
 * endpoint rather than firing many unrelated requests.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { buildHomeSnapshot } from '@/lib/home/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return NextResponse.json(buildHomeSnapshot(getDb()));
}
