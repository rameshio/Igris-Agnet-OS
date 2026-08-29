/**
 * One company task (Architecture V2 · F0.2).
 *   GET   /api/company-tasks/:id   — the task + its prerequisites + satisfied flag
 *   PATCH /api/company-tasks/:id   — update fields / guarded status transition
 *
 * `workflowId`/`runId` are references only — F0.2 never runs anything.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { getCompanyTask, getTaskDependencies, updateCompanyTask, companyErrorInfo } from '@/lib/company/service';
import { retryDecisionForTask, retryTimingForTask } from '@/lib/company/manager/retry';
import { evaluateReassignment } from '@/lib/company/manager/reassign';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  const task = getCompanyTask(db, params.id);
  if (!task) return NextResponse.json({ error: 'task not found' }, { status: 404 });
  const { dependsOn, satisfied } = getTaskDependencies(db, params.id);
  // Reliability G1 (additive): the retry decision for a failed task (safe metadata only).
  const retry = task.status === 'failed' ? retryDecisionForTask(db, params.id) : null;
  // Reliability G4 (additive): derived retry timing — nextRetryAt + due + retryAfterMs (read-time).
  const retryTiming = task.status === 'failed' ? retryTimingForTask(db, params.id) : null;
  // Reliability G3 (additive): the reassignment decision for a failed task (read-only, canonical).
  const reassignment = task.status === 'failed' ? evaluateReassignment(db, params.id) : null;
  return NextResponse.json({ task, dependsOn, prerequisitesSatisfied: satisfied, retry, retryTiming, reassignment });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ task: updateCompanyTask(getDb(), params.id, body) });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
