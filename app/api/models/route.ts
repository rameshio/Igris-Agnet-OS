/**
 * Model-provider board API (Phase B).
 *   GET                                   → providers (status/enabled/models) + Hermes brain
 *   POST {providerId, action:'connect', apiKey?, baseUrl?, displayName?}
 *   POST {providerId, action:'test'}      → real backend check + live /models fetch
 *   POST {providerId, action:'enable'|'disable'}
 *   DELETE {providerId}                   → remove credential + connection row
 *
 * Secrets: API keys are written to .env.local (backend-only) and NEVER returned.
 * The DB row (model_provider_connections) holds status/config only. A blank
 * apiKey on connect does NOT erase an existing key.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { MODEL_PROVIDERS, providerById, providerRequiresKey } from '@/lib/models/catalog';
import { resolveConnection, providerState } from '@/lib/models/connections';
import { fetchProviderModels } from '@/lib/connectors/openai-compatible';
import { activeLlmProviderName } from '@/lib/connectors/llm';
import { upsertEnvLocal, removeEnvLocal, readEnvLocal } from '@/lib/creds';
import type { FounderDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Client-safe provider view — never includes the secret. */
function providerView(db: FounderDb, providerId: string) {
  const conn = resolveConnection(db, providerId)!;
  const row = db.modelConnections.get(providerId);
  const enabled = row ? row.enabled : true;
  const needsKey = providerRequiresKey(conn.provider);
  const usable = (needsKey ? conn.hasCredential : true) && Boolean(conn.baseUrl) && enabled;
  return {
    id: conn.provider.id,
    name: conn.provider.name,
    docsUrl: conn.provider.docsUrl,
    requiresKey: needsKey,
    local: conn.provider.local ?? false,
    allowBaseUrl: conn.provider.allowBaseUrl ?? false,
    baseUrl: conn.baseUrl,
    hasCredential: conn.hasCredential,
    enabled,
    status: providerState(db, providerId),
    connected: usable, // "usable as a Fixed-strategy model source"
    models: conn.provider.models,
    lastCheckAt: row?.lastCheckAt ?? null,
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastError: row?.lastError ?? null,
  };
}

export function GET() {
  const db = getDb();
  const providers = MODEL_PROVIDERS.map((p) => providerView(db, p.id));
  // Hermes is a BRAIN/runtime, not a raw API-key provider — reported separately
  // and honestly (we do not spawn a process just to populate the UI).
  const active = activeLlmProviderName();
  const brain = {
    id: 'hermes',
    name: 'Hermes',
    transport: 'ACP',
    activeProvider: active,
    isActive: /hermes/.test(active),
    status: 'unknown', // not probed here; truthful rather than a fake "connected"
  };
  return NextResponse.json({ providers, brain });
}

const isHttpUrl = (u: string) => /^https?:\/\//i.test(u);

const PostBody = z.object({
  providerId: z.string().min(1),
  action: z.enum(['connect', 'test', 'enable', 'disable']).default('connect'),
  apiKey: z.string().max(600).optional(),
  baseUrl: z.string().max(400).optional(),
  displayName: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: 'bad body' }, { status: 400 });
  }
  const db = getDb();
  const provider = providerById(body.providerId);
  if (!provider) return NextResponse.json({ ok: false, error: 'unknown provider' }, { status: 400 });

  if (body.action === 'enable' || body.action === 'disable') {
    db.modelConnections.upsert(provider.id, { enabled: body.action === 'enable' });
    return NextResponse.json({ ok: true, provider: providerView(db, provider.id) });
  }

  if (body.action === 'test') {
    const conn = resolveConnection(db, provider.id)!;
    if (providerRequiresKey(provider) && !conn.hasCredential) {
      db.modelConnections.recordCheck(provider.id, { ok: false, error: 'no API key configured' });
      return NextResponse.json({ ok: false, error: 'no API key configured' }, { status: 400 });
    }
    if (!conn.baseUrl) {
      db.modelConnections.recordCheck(provider.id, { ok: false, error: 'no base URL configured' });
      return NextResponse.json({ ok: false, error: 'no base URL configured' }, { status: 400 });
    }
    try {
      const models = await fetchProviderModels(conn.baseUrl, conn.apiKey ?? '');
      db.modelConnections.recordCheck(provider.id, { ok: true });
      return NextResponse.json({ ok: true, count: models.length, models: models.slice(0, 200), provider: providerView(db, provider.id) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db.modelConnections.recordCheck(provider.id, { ok: false, error: msg });
      return NextResponse.json({ ok: false, error: msg.slice(0, 200), provider: providerView(db, provider.id) }, { status: 502 });
    }
  }

  // action === 'connect' — write credential (if provided) + connection metadata
  const baseUrl = body.baseUrl?.trim();
  if (baseUrl && !isHttpUrl(baseUrl)) {
    return NextResponse.json({ ok: false, error: 'base URL must start with http:// or https://' }, { status: 400 });
  }
  const apiKey = body.apiKey?.trim();
  if (apiKey) {
    if (/[\r\n]/.test(apiKey)) return NextResponse.json({ ok: false, error: 'invalid key' }, { status: 400 });
    upsertEnvLocal({ [provider.envKey]: apiKey });
  } // a blank apiKey never erases an existing one
  // require a key present for key-requiring providers unless one already exists
  if (providerRequiresKey(provider) && !apiKey && !readEnvLocal()[provider.envKey]) {
    return NextResponse.json({ ok: false, error: `${provider.name} needs an API key` }, { status: 400 });
  }
  db.modelConnections.upsert(provider.id, { baseUrl: baseUrl ?? undefined, displayName: body.displayName, enabled: true });
  return NextResponse.json({ ok: true, provider: providerView(db, provider.id) });
}

const DeleteBody = z.object({ providerId: z.string().min(1) });

export async function DELETE(req: Request) {
  let body: z.infer<typeof DeleteBody>;
  try {
    body = DeleteBody.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: 'bad body' }, { status: 400 });
  }
  const provider = providerById(body.providerId);
  if (!provider) return NextResponse.json({ ok: false, error: 'unknown provider' }, { status: 400 });
  const db = getDb();
  removeEnvLocal([provider.envKey]);
  db.modelConnections.remove(provider.id);
  return NextResponse.json({ ok: true });
}
