/**
 * Missions API (Architecture V2 · F0.2).
 *   GET  /api/missions   — list company missions (newest first)
 *   POST /api/missions   — create a mission (draft)
 *
 * Planning/organization only — no execution. React never touches SQLite; input
 * is Zod-validated in the service.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { createMission, listMissions, companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return NextResponse.json({ missions: listMissions(getDb()) });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ mission: createMission(getDb(), body) });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
