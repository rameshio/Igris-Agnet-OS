/**
 * POST /api/flow-approvals/:id/approve (Phase E). Resolves a PENDING approval as
 * approved and resumes its run in the background. The client sends ONLY the
 * approval id (path) and an optional note — the run/workflow/routes come from the
 * persisted row, never the client. Idempotent: a second approve returns 200 with
 * `alreadyResolved: true` and never resumes the run twice.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { resolveApproval } from '@/lib/flows/approvals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({ note: z.string().max(2000).optional() });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const db = getDb();

  let note: string | undefined;
  try {
    const raw = await req.json().catch(() => ({}));
    note = Body.parse(raw ?? {}).note;
  } catch {
    return NextResponse.json({ ok: false, error: 'bad body' }, { status: 400 });
  }

  const result = resolveApproval(db, params.id, 'approved', { note: note ?? null });
  if (!result.ok && result.code === 'not_found') {
    return NextResponse.json({ ok: false, error: 'approval not found' }, { status: 404 });
  }
  if (!result.ok) {
    // already resolved by a prior call — surface the current row, do not error hard
    return NextResponse.json({ ok: true, alreadyResolved: true, approval: result.approval });
  }
  return NextResponse.json({ ok: true, approval: result.approval, resumed: result.resumed });
}
