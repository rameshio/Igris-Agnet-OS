/**
 * Dispatch one company task (Architecture V2 · F1) — the Manager requests execution
 * through the EXISTING agent runtime OR the EXISTING Workflow Engine (published
 * version only). Idempotent, dependency-aware; an unmatched task returns a
 * structured capability gap (F1 never creates an agent — that is F2).
 *   POST /api/company-tasks/:id/dispatch
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { dispatchTask } from '@/lib/company/manager/delegation';
import { companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const result = await dispatchTask(getDb(), params.id);
    return NextResponse.json(result);
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
