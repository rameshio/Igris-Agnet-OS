/**
 * Per-agent capability assignment API (Architecture V2 · F0.1).
 *   GET    /api/agents/:id/capabilities   — capabilities assigned to the agent
 *   POST   /api/agents/:id/capabilities   — assign a capability (idempotent)
 *   DELETE /api/agents/:id/capabilities?capabilityId=… — remove an assignment
 *
 * Registry data only — declaring WHAT an agent CAN do. This is NOT a permission
 * grant and NEVER runs, delegates, or creates anything. The capability must exist
 * in the catalog first (explicit — no guessing). Works for built-in AND custom
 * agents (the agent id is the canonical RuntimeAgent id).
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { AgentCapabilityAssignSchema } from '@/lib/agents/capabilities';
import { getAgentById, getCapabilitiesForAgent } from '@/lib/agents/registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  if (!getAgentById(db, params.id)) return NextResponse.json({ error: 'unknown agent' }, { status: 404 });
  return NextResponse.json({ agentId: params.id, capabilities: getCapabilitiesForAgent(db, params.id) });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  if (!getAgentById(db, params.id)) return NextResponse.json({ error: 'unknown agent' }, { status: 404 });

  const raw = await req.json().catch(() => null);
  const parsed = AgentCapabilityAssignSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid assignment', issues: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  }
  // The capability must be defined first — never conjure one on assignment.
  if (!db.capabilities.get(parsed.data.capabilityId)) {
    return NextResponse.json({ error: `unknown capability: ${parsed.data.capabilityId}` }, { status: 400 });
  }
  return NextResponse.json({ assignment: db.agentCapabilities.assign(params.id, parsed.data) });
}

export function DELETE(req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  const capabilityId = new URL(req.url).searchParams.get('capabilityId');
  if (!capabilityId) return NextResponse.json({ error: 'capabilityId required' }, { status: 400 });
  db.agentCapabilities.remove(params.id, capabilityId);
  return NextResponse.json({ ok: true });
}
