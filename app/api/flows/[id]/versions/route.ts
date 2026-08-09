/**
 * Immutable workflow versions (Phase A).
 *   GET  /api/flows/:id/versions   → list published versions
 *   POST /api/flows/:id/versions   → publish the current draft as a new immutable
 *                                    version (validated first; invalid → 400)
 *
 * Versions exist so historical runs (Phase C) always reference a frozen
 * definition. Publishing is the "meaningful snapshot" — ordinary draft saves do
 * NOT create versions, avoiding version explosion.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { validateWorkflowGraph } from '@/lib/flows/validator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  if (!db.flowWorkflows.get(params.id)) return NextResponse.json({ error: 'workflow not found' }, { status: 404 });
  return NextResponse.json({ versions: db.flowVersions.forWorkflow(params.id) });
}

export function POST(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  const wf = db.flowWorkflows.get(params.id);
  if (!wf) return NextResponse.json({ error: 'workflow not found' }, { status: 404 });

  const agentIds = new Set(allRuntimeAgents(db).map((a) => a.id));
  const validation = validateWorkflowGraph(wf.draftGraph, { agentIds, requireNonEmpty: true });
  if (!validation.ok) {
    return NextResponse.json({ ok: false, error: 'workflow is invalid — fix issues before publishing', validation }, { status: 400 });
  }

  const version = db.flowVersions.nextVersion(params.id);
  db.flowVersions.create({ id: `${params.id}-v${version}`, workflowId: params.id, version, graph: wf.draftGraph });
  db.flowWorkflows.setCurrentVersion(params.id, version);
  return NextResponse.json({ ok: true, version });
}
