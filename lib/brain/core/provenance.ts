/**
 * Canonical-ref resolution state (Architecture V2 · preserved provenance).
 *
 * A promoted durable G-Brain record may OUTLIVE its source Mission/Artifact (mission
 * cleanup deletes owned company records but intentionally preserves brain_entities /
 * brain_sources / brain_knowledge). A canonicalRef whose owning object no longer exists
 * must be represented HONESTLY — never fabricated. This is the one small, shared read that
 * reports whether a ref still resolves. No DB change, no reconstruction.
 */
import type { FounderDb } from '@/lib/db';
import { resolveCanonicalRef } from '@/lib/brain/core/entities';
import type { CanonicalRef } from '@/lib/brain/core/model';

/** `live` = the owning object still exists; `missing` = it was deleted (provenance persists). */
export type CanonicalState = 'live' | 'missing';

/** Honest resolution state for a canonical ref — reuses the read-only owning-system lookup. */
export function canonicalRefState(db: FounderDb, ref: CanonicalRef): CanonicalState {
  return resolveCanonicalRef(db, ref) === null ? 'missing' : 'live';
}
