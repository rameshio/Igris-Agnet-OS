/**
 * GET /api/flow-approvals/:id (Phase E) — one approval, for a detail view.
 * Returns the persisted row (non-secret context only).
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  const approval = db.flowApprovals.get(params.id);
  if (!approval) return NextResponse.json({ error: 'approval not found' }, { status: 404 });
  return NextResponse.json({ approval });
}
