/**
 * Manual task assignment (Architecture V2 · F0.2).
 *   POST /api/company-tasks/:id/assign   { agentId }
 *
 * HONEST assignment: if the task declares required capabilities, the agent must
 * satisfy ALL of them (F0.1 resolver) — otherwise the assignment is REJECTED
 * (409). Assigning does NOT run anything, grant permission, or delegate; it only
 * records who is responsible and moves a `queued` task to `assigned`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { assignTask, companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({ agentId: z.string().min(1) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const parsed = Body.parse(await req.json().catch(() => ({})));
    return NextResponse.json({ task: assignTask(getDb(), params.id, parsed.agentId) });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
