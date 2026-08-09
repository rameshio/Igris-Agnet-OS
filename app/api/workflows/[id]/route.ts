/**
 * Single workflow endpoint.
 *   PATCH  /api/workflows/:id → replace its editable fields (name, subtitle, steps)
 *   DELETE /api/workflows/:id → remove it
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { updateWorkflow } from '@/lib/workflows-crud';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // better-sqlite3 is native — keep off the edge runtime

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  if (!db.workflows.get(params.id)) {
    return NextResponse.json({ error: `workflow not found: ${params.id}` }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  try {
    const workflow = updateWorkflow(db, params.id, body);
    return NextResponse.json({ workflow });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  if (!db.workflows.get(params.id)) {
    return NextResponse.json({ error: `workflow not found: ${params.id}` }, { status: 404 });
  }
  db.workflows.remove(params.id);
  return NextResponse.json({ ok: true });
}
