/**
 * Run ONE bounded Executive-Manager tick (Architecture V2 · F1):
 *   reconcile running workflow tasks → promote satisfied dependencies → dispatch
 *   up to `maxSteps` actionable tasks → derive mission completion.
 *   POST /api/missions/:id/manager-step   { maxSteps? }
 *
 * Bounded + human-triggered — NOT an autonomous loop.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { managerStep } from '@/lib/company/manager/service';
import { companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({ maxSteps: z.number().int().min(1).max(10).optional() });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = Body.parse(await req.json().catch(() => ({})));
    const result = await managerStep(getDb(), params.id, { maxSteps: body.maxSteps });
    return NextResponse.json(result);
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
