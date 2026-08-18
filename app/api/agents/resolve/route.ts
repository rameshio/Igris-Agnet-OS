/**
 * Capability resolver API (Architecture V2 · F0.1) — the reusable seam the F1
 * Manager will call.
 *   GET /api/agents/resolve?capabilities=research.web,research.market&mode=all
 *
 * Answers WHO COULD DO THIS — never GO DO THIS. Read-only, deterministic,
 * exact-id matching (no LLM/embedding inference). Returns SAFE metadata only:
 * agentId, name, matched/missing capabilities, proficiency, coverage score —
 * never prompts, secrets, tool config, or instructions. Nothing is started,
 * assigned, or delegated.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { resolveAgentsForCapabilities } from '@/lib/agents/registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Query = z.object({
  capabilities: z
    .string()
    .transform((s) => s.split(',').map((c) => c.trim()).filter(Boolean))
    .pipe(z.array(z.string()).min(1)),
  mode: z.enum(['all', 'any']).default('all'),
});

export function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    capabilities: url.searchParams.get('capabilities') ?? '',
    mode: url.searchParams.get('mode') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'capabilities query required (comma-separated capability ids)' }, { status: 400 });
  }
  const { capabilities, mode } = parsed.data;
  const agents = resolveAgentsForCapabilities(getDb(), capabilities, { mode });
  return NextResponse.json({ required: capabilities, mode, agents });
}
