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
import { getEligibleAgentsForTask, getTaskToolGaps, companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const db = getDb();
    // `agents` = who is genuinely eligible (capability + required tool). `toolGaps` explains
    // WHY the list may be empty for a tool-backed capability (safe reason, no connector config).
    return NextResponse.json({ agents: getEligibleAgentsForTask(db, params.id), toolGaps: getTaskToolGaps(db, params.id) });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
