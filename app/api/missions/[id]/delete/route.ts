/**
 * DELETE a test mission (Architecture V2 · consolidation) — DESTRUCTIVE, scoped, and
 * server-authoritative. Requires an explicit `{ confirm: true }` (U3 preview → confirm).
 * Cascades ONLY the mission's owned records (tasks/deps/artifacts/events/proposals),
 * RETIRES temporary mission-bound agents (never hard-deletes them), and NEVER touches
 * shared agents, reusable workflows, or durable promoted knowledge. There is no global
 * wipe — this endpoint only ever affects the one named mission.
 *   POST /api/missions/:id/delete   body: { "confirm": true }
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { deleteTestMission } from '@/lib/company/cleanup/service';
import { companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = (await req.json().catch(() => ({}))) as { confirm?: boolean };
    return NextResponse.json(deleteTestMission(getDb(), params.id, { confirm: body.confirm === true }));
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
