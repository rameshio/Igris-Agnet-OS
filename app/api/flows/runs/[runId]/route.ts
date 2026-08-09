/**
 * GET /api/flows/runs/:runId (Phase C) — a run + its node runs for the Run
 * Inspector. Reconciles stale `running` runs to `interrupted` on read. Node runs
 * carry provider/model/usage metadata but never credentials.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { reconcile } from '@/lib/flows/coordinator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { runId: string } }) {
  const db = getDb();
  const run = reconcile(db, params.runId);
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });
  const nodeRuns = db.flowNodeRuns.forRun(run.id);
  const wf = db.flowWorkflows.get(run.workflowId);

  // Final output = succeeded Output node outputs (deterministic, from persistence).
  const outParts = nodeRuns
    .filter((nr) => nr.nodeType === 'output' && nr.status === 'success')
    .map((nr) => nr.output?.text ?? '')
    .filter(Boolean);
  const finalOutput = outParts.length ? { text: outParts.join('\n\n') } : null;

  return NextResponse.json({
    run,
    workflow: wf ? { id: wf.id, name: wf.name } : null,
    nodeRuns,
    finalOutput,
  });
}
