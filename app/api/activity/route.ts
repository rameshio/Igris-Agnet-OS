/**
 * Activity / Ops Stream (UX Foundation U4).
 *   GET /api/activity?limit=50&filter=all
 *
 * A READ-ONLY projection over authoritative run/approval/node-run state — no
 * mutation, no new table. Events carry identifiers + safe labels only (see
 * lib/activity/model.ts + docs/SECURITY.md). `filter` is optional; the panel
 * fetches `all` and filters client-side, but the param exists so other surfaces
 * (e.g. a future Home recent-activity strip) can request a slice server-side.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { buildActivityFeed } from '@/lib/activity/service';
import { ACTIVITY_FILTERS, ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT } from '@/lib/activity/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(ACTIVITY_MAX_LIMIT).default(ACTIVITY_DEFAULT_LIMIT),
  filter: z.enum(ACTIVITY_FILTERS).default('all'),
});

export function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    filter: url.searchParams.get('filter') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad query' }, { status: 400 });
  }
  const events = buildActivityFeed(getDb(), parsed.data);
  return NextResponse.json({ events, generatedAt: new Date().toISOString() });
}
