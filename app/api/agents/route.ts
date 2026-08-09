/**
 * Agents collection endpoint.
 *   GET  /api/agents  → the built-in roster plus the client-created custom agents
 *   POST /api/agents  → create a custom agent from a validated payload
 * The built-in roster is code, not data, so POST only ever adds custom agents.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { createCustomAgent } from '@/lib/agents/custom';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // better-sqlite3 is native — keep off the edge runtime

export async function GET() {
  const db = getDb();
  return NextResponse.json({ agents: db.agents.all(), customAgents: db.customAgents.all() });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  try {
    const agent = createCustomAgent(getDb(), body);
    return NextResponse.json({ agent }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
