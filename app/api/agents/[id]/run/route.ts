import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { createRuntime } from '@/lib/agents/runtime';
import { allRuntimeAgents } from '@/lib/agents/registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // better-sqlite3 is native — keep off the edge runtime

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  const rt = createRuntime(db, allRuntimeAgents(db));
  try {
    const run = await rt.run(params.id);
    return NextResponse.json({ run });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 404 },
    );
  }
}
