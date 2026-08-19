/**
 * Reject an agent proposal (Architecture V2 · F2). Human-gated; creates nothing.
 * Idempotent — re-rejecting a rejected proposal is a no-op.
 *   POST /api/agent-proposals/:id/reject   body: { actor?: string }
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { rejectProposal } from '@/lib/company/factory/service';
import { companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = (await req.json().catch(() => ({}))) as { actor?: string };
    const proposal = rejectProposal(getDb(), params.id, { actor: body?.actor });
    return NextResponse.json({ proposal });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
