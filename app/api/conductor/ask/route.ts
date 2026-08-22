/**
 * Conductor Ask (IGRIS CLI · `igris ask`) — READ-ONLY operator query.
 *   POST /api/conductor/ask { question, model? } → { answer, model, adapter, context }
 *
 * Grounded in a safe, deterministic company-context summary and answered through the
 * unified model runtime (no silent fallback). Never mutates state, never dispatches,
 * never returns a secret or approval `context_json`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { askConductor } from '@/lib/conductor/ask';
import { ModelRouteError } from '@/lib/models/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({ question: z.string().min(1).max(2000), model: z.string().max(120).optional() });

export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }
  try {
    const result = await askConductor(getDb(), { question: body.question, model: body.model });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ModelRouteError) {
      // Honest, distinct model/runtime failure — 400 for a bad selection, 502 for provider/runtime.
      const status = err.code === 'model_capability_mismatch' || err.code === 'unsupported_strategy' || err.code === 'auto_not_implemented' ? 400 : 502;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'ask failed' }, { status: 400 });
  }
}
