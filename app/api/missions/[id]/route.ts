/**
 * One mission (Architecture V2 · F0.2).
 *   GET   /api/missions/:id   — the mission + a read-only task-status summary
 *   PATCH /api/missions/:id   — update title/objective/priority/status (guarded transition)
 *
 * No execution; mission status is authoritative explicit state (F0.2 never
 * auto-completes a mission from its tasks).
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { getMission, updateMission, missionSummary, companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  const mission = getMission(db, params.id);
  if (!mission) return NextResponse.json({ error: 'mission not found' }, { status: 404 });
  return NextResponse.json({ mission, summary: missionSummary(db, params.id) });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ mission: updateMission(getDb(), params.id, body) });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
