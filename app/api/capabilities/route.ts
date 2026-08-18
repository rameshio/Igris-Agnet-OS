/**
 * Capability catalog API (Architecture V2 · F0.1).
 *   GET  /api/capabilities        — list capability definitions
 *   POST /api/capabilities        — create/update one (idempotent, validated)
 *
 * Registry data only — defining WHAT work can exist. No execution, no assignment
 * here (assignment lives under /api/agents/:id/capabilities). React never touches
 * SQLite; every write is Zod-validated at this boundary.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { CapabilityInputSchema } from '@/lib/agents/capabilities';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return NextResponse.json({ capabilities: getDb().capabilities.all() });
}

export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  const parsed = CapabilityInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid capability', issues: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  }
  return NextResponse.json({ capability: getDb().capabilities.upsert(parsed.data) });
}
