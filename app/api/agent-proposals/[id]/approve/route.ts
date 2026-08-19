/**
 * Approve (promote) an agent proposal (Architecture V2 · F2). Human-gated: this is the
 * ONLY place a factory agent is created. Idempotent — a double approve promotes exactly
 * once. Reuses createCustomAgent under the stored policy; assigns the gap capabilities.
 *   POST /api/agent-proposals/:id/approve   body: { actor?: string }
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { promoteProposal } from '@/lib/company/factory/service';
import { companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = (await req.json().catch(() => ({}))) as { actor?: string };
    const result = promoteProposal(getDb(), params.id, { actor: body?.actor });
    return NextResponse.json(result);
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
