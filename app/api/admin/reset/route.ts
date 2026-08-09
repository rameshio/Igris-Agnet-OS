/**
 * POST /api/admin/reset  — reset the workspace.
 *   body { scope: 'activity' }  → wipe the accumulated activity logs only
 *   body { scope: 'demo' }      → full "start clean": demo business data + logs
 * `scope` is required: an empty/omitted scope is a 400 so a stray call can never
 * silently wipe a workspace. Custom agents and the built-in roster always survive.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { ResetScopeSchema, resetWorkspace } from '@/lib/reset';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // better-sqlite3 is native — keep off the edge runtime

export async function POST(req: Request) {
  let scope: unknown;
  try {
    const body = (await req.json()) as { scope?: unknown };
    scope = body?.scope;
  } catch {
    // no body → scope stays undefined → 400 below
  }
  const parsed = ResetScopeSchema.safeParse(scope);
  if (!parsed.success) {
    return NextResponse.json({ error: "scope is required — use 'activity' or 'demo'" }, { status: 400 });
  }
  const result = resetWorkspace(getDb(), parsed.data);
  return NextResponse.json({ result });
}
