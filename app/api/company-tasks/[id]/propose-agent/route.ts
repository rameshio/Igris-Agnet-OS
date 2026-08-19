/**
 * Propose a new agent to fill THIS task's capability gap (Architecture V2 · F2).
 * The LLM proposes; the SERVER validates against the factory policy and stores a
 * PENDING proposal — NO agent is created here (a human must approve to promote).
 *   POST /api/company-tasks/:id/propose-agent   body: { policyOverride?: {...} }
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { proposeAgentForGap } from '@/lib/company/factory/service';
import { companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = (await req.json().catch(() => ({}))) as { policyOverride?: unknown };
    const proposal = await proposeAgentForGap(getDb(), params.id, { policyOverride: body?.policyOverride });
    return NextResponse.json({ proposal });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
