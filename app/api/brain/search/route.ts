/**
 * G-Brain Core search (Architecture V2 · F3). Deterministic keyword search over entity
 * names, knowledge titles + content, and source titles. Bounded; no vector DB, no Neo4j.
 *   GET /api/brain/search?q=...&limit=20
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { searchBrain, SEARCH_LIMIT_DEFAULT } from '@/lib/brain/core/search';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : SEARCH_LIMIT_DEFAULT;
  return NextResponse.json({ query: q, results: searchBrain(getDb(), q, limit) });
}
