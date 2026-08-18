/**
 * Eligible agents for a task (Architecture V2 · F0.2) — WHO COULD DO THIS.
 *   GET /api/company-tasks/:id/eligible-agents
 *
 * The F0.1 capability resolver over the task's required capabilities (mode `all`).
 * Read-only, deterministic, SAFE metadata only (agentId/name/matched/missing/
 * proficiency/score). It never assigns, runs, or creates an agent. Empty when the
 * task declares no required capabilities, or when nothing matches (no guess).
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { getEligibleAgentsForTask, companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    return NextResponse.json({ agents: getEligibleAgentsForTask(getDb(), params.id) });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
