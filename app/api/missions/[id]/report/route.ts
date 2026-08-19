/**
 * Mission report (Architecture V2 · F1) — a DETERMINISTIC read model: task counts,
 * safe artifact summaries, blockers, capability gaps. `?synthesize=true` adds an
 * optional grounded `managerSummary` (never mutates state; best-effort).
 *   GET /api/missions/:id/report[?synthesize=true]
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { missionReport, synthesizeMissionSummary } from '@/lib/company/manager/service';
import { companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const synthesize = new URL(req.url).searchParams.get('synthesize') === 'true';
    const report = synthesize ? await synthesizeMissionSummary(getDb(), params.id) : missionReport(getDb(), params.id);
    return NextResponse.json({ report });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
