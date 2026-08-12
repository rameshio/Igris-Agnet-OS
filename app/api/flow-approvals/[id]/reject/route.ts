/**
 * POST /api/flow-approvals/:id/reject (Phase E). Resolves a PENDING approval as
 * rejected and resumes its run down the reject route. A rejection is a normal
 * outcome, NOT an execution failure. Same client contract + idempotency as
 * approve: only the id (path) and an optional note; the run is never resumed twice.
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

  const result = resolveApproval(db, params.id, 'rejected', { note: note ?? null });
  if (!result.ok && result.code === 'not_found') {
    return NextResponse.json({ ok: false, error: 'approval not found' }, { status: 404 });
  }
  if (!result.ok) {
    return NextResponse.json({ ok: true, alreadyResolved: true, approval: result.approval });
  }
  return NextResponse.json({ ok: true, approval: result.approval, resumed: result.resumed });
}
