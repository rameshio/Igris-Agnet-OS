/**
 * Single workflow (Phase A).
 *   GET    /api/flows/:id            → workflow + its editable draft graph + versions
 *   PATCH  /api/flows/:id            → save draft graph and/or rename/description
 *   DELETE /api/flows/:id            → remove the workflow (and its versions)
 *
 * Draft saves are non-blocking: a work-in-progress graph may be invalid, so we
 * persist it and return the validator issues alongside (publishing a version,
 * in ./versions, is what enforces validity).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { WorkflowGraphSchema } from '@/lib/flows/schema';
import { validateWorkflowGraph } from '@/lib/flows/validator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  const wf = db.flowWorkflows.get(params.id);
  if (!wf) return NextResponse.json({ error: 'workflow not found' }, { status: 404 });
  return NextResponse.json({
    workflow: { id: wf.id, name: wf.name, description: wf.description, currentVersion: wf.currentVersion, updatedAt: wf.updatedAt },
    graph: wf.draftGraph,
    versions: db.flowVersions.forWorkflow(wf.id),
  });
}

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).optional(),
  graph: z.unknown().optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  const wf = db.flowWorkflows.get(params.id);
  if (!wf) return NextResponse.json({ error: 'workflow not found' }, { status: 404 });

  let body: z.infer<typeof PatchBody>;
  try {
    body = PatchBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: 'bad body' }, { status: 400 });
  }

  let validation = null;
  if (body.graph !== undefined) {
    const parsed = WorkflowGraphSchema.safeParse(body.graph);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: `malformed graph: ${parsed.error.issues[0]?.message}` }, { status: 400 });
    }
    db.flowWorkflows.saveDraft(params.id, parsed.data);
    const agentIds = new Set(allRuntimeAgents(db).map((a) => a.id));
    validation = validateWorkflowGraph(parsed.data, { agentIds });
  }
  if (body.name !== undefined || body.description !== undefined) {
    db.flowWorkflows.updateMeta(params.id, { name: body.name, description: body.description });
  }
  return NextResponse.json({ ok: true, validation });
}

export function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  if (!db.flowWorkflows.get(params.id)) return NextResponse.json({ error: 'workflow not found' }, { status: 404 });
  db.flowWorkflows.remove(params.id);
  return NextResponse.json({ ok: true });
}
