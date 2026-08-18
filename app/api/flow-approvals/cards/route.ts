/**
 * GET /api/flow-approvals/cards (UX Foundation U5, Part A) — the Approval
 * Decision Card projection for the /approvals surface. Returns SAFE view models
 * (pending + recent resolved) with workflow name, approve/reject effects, and a
 * conservative risk level. It NEVER returns raw context_json (unlike the legacy
 * GET /api/flow-approvals list, kept intact for Phase-E compatibility).
 *
 * Read-only: no mutation, no new table. Approvals are still resolved only via
 * POST /api/flow-approvals/:id/approve|reject (Phase E, unchanged).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { buildApprovalCards } from '@/lib/flows/approval-cards';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Query = z.object({
  resolvedLimit: z.coerce.number().int().min(0).max(200).default(40),
});

export function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({ resolvedLimit: url.searchParams.get('resolvedLimit') ?? undefined });
  if (!parsed.success) return NextResponse.json({ error: 'bad query' }, { status: 400 });

  const cards = buildApprovalCards(getDb(), { resolvedLimit: parsed.data.resolvedLimit });
  return NextResponse.json({ ...cards, generatedAt: new Date().toISOString() });
}
