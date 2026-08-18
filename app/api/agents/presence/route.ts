/**
 * GET /api/agents/presence (UX Foundation U5, Part B) — a READ-ONLY projection of
 * derived agent operational state (working / waiting_approval / failed). One
 * shared, bounded request drives every agent's presence dot on /agents — never a
 * request per agent. No mutation, no new table, no fabricated status.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { buildAgentPresence } from '@/lib/agents/presence-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  const presence = buildAgentPresence(getDb());
  return NextResponse.json({ presence, generatedAt: new Date().toISOString() });
}
