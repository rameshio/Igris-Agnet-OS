import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { createRuntime } from '@/lib/agents/runtime';
import { allRuntimeAgents } from '@/lib/agents/registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // better-sqlite3 is native — keep off the edge runtime

export async function GET() {
  return NextResponse.json({ broadcasts: getDb().broadcasts.recent(10) });
}

export async function POST(req: Request) {
  let message = '';
  try {
    const body = (await req.json()) as { message?: unknown };
    message = typeof body.message === 'string' ? body.message.trim() : '';
  } catch {
    // fall through to the empty-message rejection
  }
  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }
  const db = getDb();
  const rt = createRuntime(db, allRuntimeAgents(db));
  const broadcast = await rt.broadcast(message);
  return NextResponse.json({ broadcast });
}
