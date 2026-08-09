/**
 * Single custom-agent endpoint.
 *   PATCH  /api/agents/:id → apply a partial update (name, instructions, …)
 *   DELETE /api/agents/:id → remove the agent
 * Only client-created custom agents are mutable; a built-in id (or an unknown
 * one) is a 404 so the code-defined roster stays immutable.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { updateCustomAgent } from '@/lib/agents/custom';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // better-sqlite3 is native — keep off the edge runtime

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  if (!db.customAgents.get(params.id)) {
    return NextResponse.json({ error: `custom agent not found: ${params.id}` }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  try {
    const agent = updateCustomAgent(db, params.id, body);
    return NextResponse.json({ agent });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  if (!db.customAgents.get(params.id)) {
    return NextResponse.json({ error: `custom agent not found: ${params.id}` }, { status: 404 });
  }
  db.customAgents.remove(params.id);
  return NextResponse.json({ ok: true });
}
