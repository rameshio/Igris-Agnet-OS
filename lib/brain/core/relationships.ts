/**
 * G-Brain Core — Relationships service (Architecture V2 · F3).
 *
 * A typed edge between two brain entities. Both endpoints must exist; a self-link is
 * rejected unless the type explicitly allows it; the same (from, to, type) is idempotent
 * (returns the existing edge). Metadata is a bounded safe scalar map — no `eval`, no
 * arbitrary predicates. `neighborhood` is the read seam a future F4 Radial view consumes.
 */
import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import {
  BrainRelationshipInputSchema,
  BrainError,
  safeEntity,
  selfLinkAllowed,
  type BrainEntity,
  type BrainRelationship,
} from '@/lib/brain/core/model';

const now = (): string => new Date().toISOString();

/** Create an edge. Idempotent on (from, to, type); validates endpoints, self-link, source. */
export function createRelationship(db: FounderDb, input: unknown): BrainRelationship {
  const parsed = BrainRelationshipInputSchema.parse(input);

  if (!db.brainEntities.get(parsed.fromEntityId)) throw new BrainError('from entity not found', 404);
  if (!db.brainEntities.get(parsed.toEntityId)) throw new BrainError('to entity not found', 404);
  if (parsed.fromEntityId === parsed.toEntityId && !selfLinkAllowed(parsed.type)) {
    throw new BrainError(`self-link not allowed for relationship type ${parsed.type}`, 400);
  }
  if (parsed.sourceId && !db.brainSources.get(parsed.sourceId)) throw new BrainError('source not found', 404);

  const existing = db.brainRelationships.find(parsed.fromEntityId, parsed.toEntityId, parsed.type);
  if (existing) return existing; // idempotent

  const rel: BrainRelationship = {
    id: `brel-${randomUUID()}`,
    fromEntityId: parsed.fromEntityId,
    toEntityId: parsed.toEntityId,
    type: parsed.type,
    strength: parsed.strength ?? null,
    metadata: parsed.metadata,
    sourceId: parsed.sourceId,
    createdAt: now(),
  };
  db.brainRelationships.insert(rel);
  return rel;
}

export type EntityNeighborhood = {
  entity: BrainEntity;
  relationships: BrainRelationship[];
  neighbors: BrainEntity[];
};

/** An entity plus its edges (both directions) and the safe neighbor entities. F4 seam. */
export function neighborhood(db: FounderDb, entityId: string): EntityNeighborhood {
  const entity = db.brainEntities.get(entityId);
  if (!entity) throw new BrainError('entity not found', 404);

  const relationships = db.brainRelationships.forEntity(entityId);
  const neighborIds = new Set<string>();
  for (const r of relationships) {
    neighborIds.add(r.fromEntityId);
    neighborIds.add(r.toEntityId);
  }
  neighborIds.delete(entityId);

  const neighbors = [...neighborIds]
    .map((id) => db.brainEntities.get(id))
    .filter((e): e is BrainEntity => e !== null)
    .map(safeEntity);

  return { entity: safeEntity(entity), relationships, neighbors };
}
