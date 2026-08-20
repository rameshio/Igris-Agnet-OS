/**
 * Explicitly promote a company Artifact (F1) into durable G-Brain knowledge with
 * provenance (Architecture V2 · F3). EXPLICIT + idempotent; the artifact is never modified
 * and no other artifact is auto-ingested. This is the ONLY artifact → G-Brain path.
 *   POST /api/company-artifacts/:id/promote-to-brain   body: { title?, kind? }
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { promoteArtifactToBrain } from '@/lib/brain/core/promote';
import { brainErrorInfo, type KnowledgeKind } from '@/lib/brain/core/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = (await req.json().catch(() => ({}))) as { title?: string; kind?: KnowledgeKind };
    const result = promoteArtifactToBrain(getDb(), params.id, { title: body?.title, kind: body?.kind });
    return NextResponse.json(result);
  } catch (err) {
    const { status, error } = brainErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
