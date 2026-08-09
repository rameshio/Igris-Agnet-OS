/**
 * Workflow runs (Phase C).
 *   GET  /api/flows/:id/runs   → recent run history for the workflow
 *   POST /api/flows/:id/runs   → start a run of a PUBLISHED immutable version
 *
 * Runs never execute a mutable draft: the published `current_version` (or an
 * explicit `version`) is used. Execution happens in-process; the caller gets the
 * run id immediately and polls GET /api/flows/runs/:runId.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/data';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { validateExecutable } from '@/lib/flows/validator';
import { startRun } from '@/lib/flows/coordinator';
import { StartRunInputSchema } from '@/lib/flows/run-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  if (!db.flowWorkflows.get(params.id)) return NextResponse.json({ error: 'workflow not found' }, { status: 404 });
  return NextResponse.json({ runs: db.flowRuns.recentForWorkflow(params.id, 20) });
}

const StartBody = z.object({ version: z.number().int().positive().optional(), input: StartRunInputSchema.default({ text: '' }) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  const wf = db.flowWorkflows.get(params.id);
  if (!wf) return NextResponse.json({ error: 'workflow not found' }, { status: 404 });

  let body: z.infer<typeof StartBody>;
  try {
    body = StartBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: 'bad body' }, { status: 400 });
  }

  const version = body.version ?? wf.currentVersion ?? null;
  if (version == null) {
    return NextResponse.json({ ok: false, error: 'Publish this workflow before running it.' }, { status: 409 });
  }
  const snapshot = db.flowVersions.get(params.id, version);
  if (!snapshot) return NextResponse.json({ ok: false, error: `version ${version} not found` }, { status: 400 });

  // Execution-valid check (pure config, no live provider probing).
  const agentIds = new Set(allRuntimeAgents(db).map((a) => a.id));
  const validation = validateExecutable(snapshot.graph, { agentIds });
  if (!validation.ok) {
    return NextResponse.json({ ok: false, error: 'workflow is not runnable', validation }, { status: 400 });
  }

  const run = db.flowRuns.create({ id: `run-${randomUUID()}`, workflowId: params.id, workflowVersion: version, startingInput: body.input });
  startRun(db, run, snapshot.graph, allRuntimeAgents(db));
  return NextResponse.json({ ok: true, runId: run.id, status: run.status, version }, { status: 201 });
}
