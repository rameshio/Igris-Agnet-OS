/**
 * Workflow list + create (Phase A).
 *   GET  /api/flows            → lightweight list of workflows
 *   POST /api/flows {name}     → create a new empty workflow (draft graph)
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { EMPTY_GRAPH } from '@/lib/flows/schema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  const db = getDb();
  const workflows = db.flowWorkflows.all().map((w) => ({
    id: w.id,
    name: w.name,
    description: w.description,
    currentVersion: w.currentVersion,
    nodeCount: w.draftGraph.nodes?.length ?? 0,
    updatedAt: w.updatedAt,
  }));
  return NextResponse.json({ workflows });
}

const CreateBody = z.object({ name: z.string().min(1).max(120), description: z.string().max(1000).optional() });

export async function POST(req: Request) {
  let body: z.infer<typeof CreateBody>;
  try {
    body = CreateBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  }
  const db = getDb();
  const id = `wf-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  const wf = db.flowWorkflows.create({ id, name: body.name, description: body.description ?? '', graph: EMPTY_GRAPH });
  return NextResponse.json({ ok: true, workflow: { id: wf.id, name: wf.name, description: wf.description } }, { status: 201 });
}
