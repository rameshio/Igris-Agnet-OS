/**
 * Hermes Runtime management (HRA-2, H2). Orthogonal to production agent traffic
 * (which still runs on ACP). Discovery / health / lifecycle for the LOCAL Hermes
 * runtime, with strict ownership + token guards.
 *
 *   GET                    → full runtime status (truthful, no secrets)
 *   POST { action }        → detect | health | configure | start | stop
 *
 * The dashboard token is NEVER returned. `configure` accepts a token but only
 * writes it to .env.local (backend-only); the response reports presence only.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { HermesRuntimeManager, defaultRuntimeDeps, RuntimeError } from '@/lib/connectors/hermes-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function manager() {
  return new HermesRuntimeManager(defaultRuntimeDeps(getDb().meta));
}

export async function GET() {
  return NextResponse.json(await manager().status());
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('detect') }),
  z.object({ action: z.literal('health') }),
  z.object({ action: z.literal('start') }),
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('set_transport'), transport: z.enum(['acp', 'serve']) }),
  z.object({
    action: z.literal('configure'),
    mode: z.enum(['managed_local', 'external_local']).optional(),
    host: z.string().max(120).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    binPath: z.string().max(400).optional(),
    enabled: z.boolean().optional(),
    /** Written to .env.local only; never persisted to the DB, never echoed back. */
    token: z.string().max(400).optional(),
  }),
]);

export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid runtime action.' }, { status: 400 });
  }

  const mgr = manager();
  try {
    switch (body.action) {
      case 'detect':
        return NextResponse.json({ ok: true, binary: await mgr.discover(), status: await mgr.status() });
      case 'health':
        return NextResponse.json({ ok: true, health: await mgr.health(), status: await mgr.status() });
      case 'configure':
        mgr.configure(body); // token (if any) → .env.local only
        return NextResponse.json({ ok: true, status: await mgr.status() });
      case 'start':
        return NextResponse.json({ ok: true, status: await mgr.startManaged() });
      case 'stop':
        return NextResponse.json({ ok: true, status: await mgr.stopManaged() });
      case 'set_transport': {
        if (body.transport === 'serve') {
          // Serve becomes production ONLY when eligible; ACP rollback is always allowed.
          const st = await mgr.status();
          if (!st.eligibility.eligible) {
            return NextResponse.json({ ok: false, error: 'Serve is not eligible for production yet.', reasons: st.eligibility.reasons, code: 'serve_ineligible' }, { status: 409 });
          }
          getDb().meta.set('hermes_production_transport', 'serve');
        } else {
          getDb().meta.set('hermes_production_transport', 'acp'); // explicit rollback
        }
        return NextResponse.json({ ok: true, status: await mgr.status() });
      }
    }
  } catch (err) {
    const code = err instanceof RuntimeError ? err.code : 'runtime_error';
    const message = err instanceof Error ? err.message.slice(0, 300) : 'Runtime action failed.';
    return NextResponse.json({ ok: false, error: message, code }, { status: 409 });
  }
}
