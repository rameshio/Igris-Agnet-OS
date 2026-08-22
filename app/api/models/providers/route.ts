/**
 * Safe provider-status projection (IGRIS CLI · model control plane).
 *   GET /api/models/providers → [{ id, name, configured, connected, capabilities, models }]
 *                               + the Hermes brain runtime + the active global default.
 *
 * A thin, credential-free view for the CLI (`igris models providers`) and automation.
 * NEVER returns an API key. Provider config/state comes from the canonical model layer.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { MODEL_PROVIDERS, providerRequiresKey } from '@/lib/models/catalog';
import { resolveConnection, providerState } from '@/lib/models/connections';
import { providerCapabilities, hermesCapabilities } from '@/lib/models/capabilities';
import { describeDefaultModel } from '@/lib/models/default-model';
import { activeLlmProviderName } from '@/lib/connectors/llm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  const db = getDb();
  const providers = MODEL_PROVIDERS.map((p) => {
    const conn = resolveConnection(db, p.id)!;
    const needsKey = providerRequiresKey(p);
    const configured = (needsKey ? conn.hasCredential : true) && Boolean(conn.baseUrl);
    return {
      id: p.id,
      name: p.name,
      transport: 'openai-compatible' as const,
      requiresKey: needsKey,
      configured, // a usable credential (or none needed) is present — NEVER the key itself
      connected: providerState(db, p.id) === 'connected',
      enabled: conn.enabled,
      capabilities: providerCapabilities(p.id),
      models: p.models,
    };
  });

  const active = activeLlmProviderName();
  const brain = {
    id: 'hermes',
    name: 'Hermes',
    transport: 'brain' as const,
    available: /hermes/.test(active),
    activeBrain: active,
    capabilities: hermesCapabilities(),
  };

  const def = describeDefaultModel(db);
  return NextResponse.json({ providers, brain, default: { model: def.model, strategy: def.settings.strategy } });
}
