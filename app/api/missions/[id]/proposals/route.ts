/**
 * List a mission's agent-factory proposals (Architecture V2 · F2) for the review
 * surface — pending, approved, and rejected. Read-only; operator-owned mission data
 * (specs carry no secrets/tokens).
 *   GET /api/missions/:id/proposals
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// A mission-scoped read feed (like /events): an unknown mission returns an empty
// list, not a 404 — the board renders nothing rather than erroring.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    return NextResponse.json({ proposals: getDb().companyAgentProposals.forMission(params.id) });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
