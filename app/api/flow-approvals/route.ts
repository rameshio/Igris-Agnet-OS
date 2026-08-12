/**
 * GET /api/flow-approvals (Phase E) — the Approvals inbox: all PENDING human
 * approvals across runs, newest first. context_json holds NON-SECRET workflow
 * data only, so the row is safe to return. Approvals are resolved via
 * POST /api/flow-approvals/:id/approve|reject (never here).
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  const db = getDb();
  return NextResponse.json({ approvals: db.flowApprovals.pending(100) });
}
