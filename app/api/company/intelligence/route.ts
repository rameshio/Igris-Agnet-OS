/**
 * Company Intelligence (Architecture V2 · F6). Bounded, READ-ONLY analytical
 * snapshot over existing company state — work health, capabilities, execution,
 * approvals, agents, and deterministic signals. No mutation endpoint exists.
 *   GET /api/company/intelligence?window=1h|24h|7d|30d   (default 7d)
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { getCompanyIntelligence } from '@/lib/company/intelligence/service';
import { intelErrorInfo } from '@/lib/company/intelligence/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: Request) {
  const url = new URL(req.url);
  try {
    const window = url.searchParams.get('window') ?? undefined;
    return NextResponse.json(getCompanyIntelligence(getDb(), { window }));
  } catch (err) {
    const { status, error } = intelErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}
