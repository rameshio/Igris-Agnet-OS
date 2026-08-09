import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { chatWithAgent } from '@/lib/agents/chat';
import { routeConductorMessage } from '@/lib/agents/conductor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // better-sqlite3 is native — keep off the edge runtime

export async function POST(req: Request, { params }: { params: { id: string } }) {
  let message = '';
  let screenContext: string | undefined;
  try {
    const body = (await req.json()) as { message?: unknown; context?: unknown };
    message = typeof body.message === 'string' ? body.message.trim() : '';
    screenContext = typeof body.context === 'string' && body.context.trim() ? body.context.slice(0, 4000) : undefined;
  } catch {
    // fall through to the empty-message rejection
  }
  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  // Resolve the target up front so a genuinely-unknown agent is a 404, while a
  // downstream failure (gateway error, Zod throw, …) surfaces honestly as a 500
  // instead of masquerading as "unknown agent". The roster includes the
  // client-created custom agents, so they are chattable too.
  const db = getDb();
  const agents = allRuntimeAgents(db);
  const isConductor = params.id === 'conductor';
  if (!isConductor && !agents.some((a) => a.id === params.id)) {
    return NextResponse.json({ error: `unknown agent: ${params.id}` }, { status: 404 });
  }

  try {
    const result = isConductor
      ? await routeConductorMessage(db, agents, message, { screenContext })
      : await chatWithAgent(db, agents, params.id, message, { screenContext });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
