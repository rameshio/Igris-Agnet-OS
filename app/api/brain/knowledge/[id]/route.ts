/**
 * One G-Brain knowledge record (Architecture V2 · F3). The single read returns the full
 * record (with content); update is explicit.
 *   GET   /api/brain/knowledge/:id
 *   PATCH /api/brain/knowledge/:id   body: BrainKnowledgeUpdate
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { getKnowledge, updateKnowledge } from '@/lib/brain/core/knowledge';
import { brainErrorInfo } from '@/lib/brain/core/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  const knowledge = getKnowledge(getDb(), params.id);
  if (!knowledge) return NextResponse.json({ error: 'knowledge not found' }, { status: 404 });
  return NextResponse.json({ knowledge });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ knowledge: updateKnowledge(getDb(), params.id, body) });
  } catch (err) {
    const { status, error } = brainErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
