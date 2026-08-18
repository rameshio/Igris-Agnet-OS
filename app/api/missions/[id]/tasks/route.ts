/**
 * Tasks under a mission (Architecture V2 · F0.2).
 *   GET  /api/missions/:id/tasks   — the mission's company tasks
 *   POST /api/missions/:id/tasks   — create a task under the mission (queued)
 *
 * Creating a task is planning only — it never assigns an agent, runs a workflow,
 * or grants any authority.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { createCompanyTask, getMission, listTasksForMission, companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  if (!getMission(db, params.id)) return NextResponse.json({ error: 'mission not found' }, { status: 404 });
  return NextResponse.json({ missionId: params.id, tasks: listTasksForMission(db, params.id) });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ task: createCompanyTask(getDb(), params.id, body) });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
