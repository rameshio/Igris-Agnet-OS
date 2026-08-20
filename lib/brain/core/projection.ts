/**
 * G-Brain Core — safe read projections + future-view seams (Architecture V2 · F3).
 *
 * These are the SAFE, read-only shapes broad graph views consume. They expose id / type /
 * name / summary / canonical ref / safe metadata only — never secrets, tokens, prompts,
 * tool credentials, approval context, or full knowledge/artifact content.
 *
 * SEAMS ONLY — F3 defines the interfaces the later phases consume; it implements NO F4/F5
 * behavior:
 *   - F4 Radial / Universal Inspector → `getEntityNeighborhood` (the neighborhood read).
 *   - F5 Neural / live operational graph → `ProjectionSource` interface (not wired to any
 *     live company-event stream; company_events remains the operational ledger).
 */
import type { FounderDb } from '@/lib/db';
import { neighborhood, type EntityNeighborhood } from '@/lib/brain/core/relationships';

/** F4 Radial seam: an entity + its immediate edges/neighbors (already safe-projected). */
export function getEntityNeighborhood(db: FounderDb, entityId: string): EntityNeighborhood {
  return neighborhood(db, entityId);
}

/**
 * F5 Neural seam (interface only). A future projection layer may COMBINE the four graphs
 * visually, but must never merge them into one DB model, and must never pipe live company
 * events into the brain automatically. Defined here so F5 has a stable contract to build on.
 */
export interface ProjectionSource {
  /** Safe nodes for a combined view. Implemented in F5, not F3. */
  nodes(): Promise<unknown[]>;
  /** Safe edges for a combined view. Implemented in F5, not F3. */
  edges(): Promise<unknown[]>;
}
