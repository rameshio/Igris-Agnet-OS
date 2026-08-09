/**
 * App-wide provider connection resolution (Phase B). Merges the catalog default,
 * the stored connection row (enabled + base-URL override + health), and the
 * backend-only credential (from .env.local) into one view. Credentials are read
 * here on the server; the raw key is never returned to callers that serialize
 * to the client.
 */
import type { FounderDb } from '@/lib/db';
import { providerById, providerRequiresKey, type ModelProvider } from '@/lib/models/catalog';
import { keyFor } from '@/lib/models/resolve';

export type ProviderState = 'not_configured' | 'configured' | 'connected' | 'error' | 'disabled';

export type ResolvedConnection = {
  provider: ModelProvider;
  enabled: boolean;
  baseUrl: string;
  hasCredential: boolean;
  /** Backend-only. Never serialize this to the client. */
  apiKey?: string;
};

/** Effective connection for a provider (row overrides catalog; env holds the key). */
export function resolveConnection(db: FounderDb, providerId: string): ResolvedConnection | null {
  const provider = providerById(providerId);
  if (!provider) return null;
  const row = db.modelConnections.get(providerId);
  const enabled = row ? row.enabled : true;
  const baseUrl = (row?.baseUrl && row.baseUrl.trim()) || provider.baseUrl;
  const apiKey = keyFor(provider);
  return { provider, enabled, baseUrl, hasCredential: Boolean(apiKey), apiKey };
}

/** Honest status for the board — reflects config + last real check, never a fake "connected". */
export function providerState(db: FounderDb, providerId: string): ProviderState {
  const conn = resolveConnection(db, providerId);
  if (!conn) return 'not_configured';
  const row = db.modelConnections.get(providerId);
  if (row && !row.enabled) return 'disabled';
  const needsKey = providerRequiresKey(conn.provider);
  const configured = (needsKey ? conn.hasCredential : true) && Boolean(conn.baseUrl);
  if (!configured) return 'not_configured';
  if (row?.lastError) return 'error';
  if (row?.lastSuccessAt) return 'connected';
  return 'configured';
}
