/**
 * Global default model — canonical server-side config (IGRIS CLI · model control plane).
 *   GET  /api/models/default            → { model, strategy }
 *   POST /api/models/default { model }  → set + persist (meta store), validated
 *
 * The default is the app-wide fallback in the selection hierarchy
 * (run override → agent model → THIS default → brain). No credential is read/written
 * here; the value is a model STRING ('' | 'hermes' | 'auto' | 'providerId:modelId').
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { getDefaultModel, setDefaultModel } from '@/lib/models/default-model';
import { parseModelSettings } from '@/lib/models/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  const model = getDefaultModel(getDb());
  return NextResponse.json({ model, strategy: parseModelSettings(model).strategy });
}

const Body = z.object({ model: z.string().max(120) });

export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: 'model is required' }, { status: 400 });
  }
  try {
    const model = setDefaultModel(getDb(), body.model);
    return NextResponse.json({ ok: true, model, strategy: parseModelSettings(model).strategy });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'invalid model' }, { status: 400 });
  }
}
