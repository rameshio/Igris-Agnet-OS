/**
 * G-Brain Core knowledge (Architecture V2 · F3). Safe list (no full content) + explicit create.
 *   GET  /api/brain/knowledge          → safe summaries (no content)
 *   POST /api/brain/knowledge          body: BrainKnowledgeInput
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { createKnowledge, listKnowledge } from '@/lib/brain/core/knowledge';
import { brainErrorInfo } from '@/lib/brain/core/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return NextResponse.json({ knowledge: listKnowledge(getDb()) });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ knowledge: createKnowledge(getDb(), body) });
  } catch (err) {
    const { status, error } = brainErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
