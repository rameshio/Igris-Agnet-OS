/**
 * Retry one FAILED company task (Reliability Phase G1).
 *   POST /api/company-tasks/:id/retry
 *
 * The controlled recovery path: it validates the task is `failed`, re-runs the
 * canonical retry decision (classification + attempt budget), and — only when the
 * decision is RETRY_ALLOWED — performs the dedicated `failed → queued` move and then
 * DISPATCHES through the EXISTING manager/dispatch path (so tool preflight, Phase-E
 * approval, and no-silent-fallback all still apply, and the attempt counter increments
 * exactly once at `running`). A non-retryable failure is rejected (409) with the
 * decision so the operator sees the reason (human action required / exhausted / etc.).
 * There is NO force flag, no provider/tool fallback, and no direct SQLite access.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { retryTask } from '@/lib/company/manager/retry';
import { dispatchTask } from '@/lib/company/manager/delegation';
import { getCompanyTask, companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const db = getDb();
    if (!getCompanyTask(db, params.id)) return NextResponse.json({ error: 'task not found' }, { status: 404 });

    const result = retryTask(db, params.id);
    if (!result.ok) {
      // Non-retryable (human action required / exhausted / permanent / not failed).
      return NextResponse.json({ ok: false, retry: result.decision }, { status: 409 });
    }
    // Controlled failed→queued succeeded — run it through the existing dispatch path.
    const dispatch = await dispatchTask(db, params.id);
    return NextResponse.json({ ok: true, retry: result.decision, task: getCompanyTask(db, params.id), dispatch });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
