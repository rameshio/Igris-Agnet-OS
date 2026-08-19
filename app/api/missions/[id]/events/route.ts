/**
 * Mission event ledger (Architecture V2 · F1) — the append-only operational events
 * for a mission (newest first, bounded). Read-only; the ledger is NOT canonical
 * state. Events carry bounded, safe metadata only (no prompts/secrets/tool args).
 *   GET /api/missions/:id/events
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { listMissionEvents } from '@/lib/company/manager/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  return NextResponse.json({ missionId: params.id, events: listMissionEvents(getDb(), params.id) });
}
