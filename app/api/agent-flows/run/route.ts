/**
 * POST /api/agent-flows/run — execute the current canvas.
 * body { nodes:[{id,agentId}], edges:[{source,target}], initialInput? }
 * Walks the edges, runs each agent in order, chains outputs, and saves each
 * step to G-Brain. Runs the posted graph directly (no need to save first).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { runAgentFlow, FLOW_SAVE } from '@/lib/agents/flow-run';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({
  nodes: z.array(z.object({ id: z.string().min(1), agentId: z.string().min(1) })).max(100),
  edges: z.array(z.object({ source: z.string().min(1), target: z.string().min(1) })).max(300),
  initialInput: z.string().max(4000).optional(),
});

export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, steps: [], detail: 'invalid flow payload' }, { status: 400 });
  }
  const db = getDb();
  const result = await runAgentFlow(
    body.nodes,
    body.edges,
    { agents: allRuntimeAgents(db), save: FLOW_SAVE },
    { initialInput: body.initialInput },
  );
  return NextResponse.json(result);
}
