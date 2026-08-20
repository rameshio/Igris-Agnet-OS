/**
 * G-Brain Neural projection (Architecture V2 · F5). Bounded, read-only live/recent operational
 * graph over the `company_events` ledger reconciled with current canonical state. No `entity` →
 * a bounded "company now" view. Read-only — never mutates; there is no mutation endpoint.
 *   GET /api/brain/neural?entity=<ref|id>&window=15m|1h|6h|24h&limit=
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { getNeuralGraph } from '@/lib/brain/neural/service';
import { brainErrorInfo } from '@/lib/brain/core/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: Request) {
  const url = new URL(req.url);
  try {
    const entity = url.searchParams.get('entity') ?? undefined;
    const window = url.searchParams.get('window') ?? undefined;
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    return NextResponse.json(getNeuralGraph(getDb(), { entity, window, limit }));
  } catch (err) {
    const { status, error } = brainErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
