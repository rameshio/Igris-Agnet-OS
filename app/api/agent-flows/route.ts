/**
 * Agent flow persistence.
 *   GET  /api/agent-flows → the saved "main" canvas (nodes + edges), or an empty one
 *   POST /api/agent-flows → save the canvas ({id?, name?, nodes, edges})
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { AgentFlowInputSchema } from '@/lib/schemas';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  const flow = getDb().agentFlows.get('main');
  return NextResponse.json({ flow: flow ?? { id: 'main', name: 'Agent Flow', nodes: [], edges: [] } });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  try {
    const parsed = AgentFlowInputSchema.parse(body);
    const db = getDb();
    const now = new Date().toISOString();
    const existing = db.agentFlows.get(parsed.id);
    const flow = { ...parsed, createdAt: existing?.createdAt ?? now, updatedAt: now };
    db.agentFlows.upsert(flow);
    return NextResponse.json({ ok: true, flow });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
