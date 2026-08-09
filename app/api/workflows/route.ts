/**
 * Workflows collection endpoint.
 *   GET  /api/workflows  → list the workflows
 *   POST /api/workflows  → create one from a validated {name, subtitle, steps} payload
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { createWorkflow } from '@/lib/workflows-crud';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // better-sqlite3 is native — keep off the edge runtime

export function GET() {
  return NextResponse.json({ workflows: getDb().workflows.all() });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  try {
    const workflow = createWorkflow(getDb(), body);
    return NextResponse.json({ workflow }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
