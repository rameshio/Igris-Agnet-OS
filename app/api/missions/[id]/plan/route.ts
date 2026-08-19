/**
 * Plan a mission (Architecture V2 · F1) — the Executive Manager decomposes the
 * mission into Company Tasks (schema-constrained; server-generated ids; F0.1/F0.2
 * validation). Planning creates/updates tasks only — it starts NO execution.
 *   POST /api/missions/:id/plan
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { planMission } from '@/lib/company/manager/planning';
import { companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const { plan, tasks } = await planMission(getDb(), params.id);
    return NextResponse.json({ rationale: plan.rationale, tasks });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
