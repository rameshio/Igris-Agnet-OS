/**
 * G-Brain Core — Entities service (Architecture V2 · F3).
 *
 * An entity is a node in the knowledge graph. It may REFERENCE a canonical object
 * (agent/mission/task/workflow/artifact/skill/tool/knowledge) via `canonicalRef`, in
 * which case the reference is validated against the REAL owning system and at most ONE
 * entity may exist per canonical ref. It NEVER copies the referenced object's mutable
 * state (tools/model/status/permissions stay owned by that system and are resolved on read).
 * Brain-native entities (concept/topic/document/…) carry no canonical ref and get a
 * server-generated id, so a client can never collide with a canonical key.
 */
import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import { getAgentById } from '@/lib/agents/registry';
import {
  BrainEntityInputSchema,
  BrainError,
  canonicalKey,
  type BrainEntity,
  type BrainEntityType,
  type CanonicalRef,
} from '@/lib/brain/core/model';

const now = (): string => new Date().toISOString();

/**
 * Resolve a canonical ref against its OWNING system. Returns a display name if the
 * referenced object exists, else null (the caller rejects an unknown ref). This is the
 * only coupling to other systems — read-only, name-only; no state is copied.
 */
export function resolveCanonicalRef(db: FounderDb, ref: CanonicalRef): string | null {
  switch (ref.kind) {
    case 'agent':
      return getAgentById(db, ref.id)?.name ?? null;
    case 'mission':
      return db.companyMissions.get(ref.id)?.title ?? null;
    case 'company_task':
      return db.companyTasks.get(ref.id)?.title ?? null;
    case 'artifact':
      return db.companyArtifacts.get(ref.id)?.title ?? null;
    case 'workflow':
      return db.flowWorkflows.get(ref.id)?.name ?? null;
    case 'skill':
      return db.skills.all().find((s) => s.id === ref.id)?.name ?? null;
    case 'tool':
      return db.tools.all().find((t) => t.id === ref.id)?.name ?? null;
    case 'knowledge':
      return db.brainKnowledge.get(ref.id)?.title ?? null;
    default:
      return null;
  }
}

/**
 * Create an entity. If it carries a canonical ref: the ref must resolve, and if an entity
 * already exists for that canonical key the EXISTING one is returned (idempotent — one
 * entity per canonical ref, never a duplicate).
 */
export function createEntity(db: FounderDb, input: unknown): BrainEntity {
  const parsed = BrainEntityInputSchema.parse(input);

  if (parsed.canonicalRef) {
    const name = resolveCanonicalRef(db, parsed.canonicalRef);
    if (name === null) throw new BrainError(`canonical ref not found: ${canonicalKey(parsed.canonicalRef.kind, parsed.canonicalRef.id)}`, 404);
    const existing = db.brainEntities.getByCanonicalKey(canonicalKey(parsed.canonicalRef.kind, parsed.canonicalRef.id));
    if (existing) return existing;
  }

  const entity: BrainEntity = {
    id: `bent-${randomUUID()}`,
    type: parsed.type,
    name: parsed.name,
    summary: parsed.summary,
    canonicalRef: parsed.canonicalRef,
    createdAt: now(),
    updatedAt: now(),
  };
  db.brainEntities.insert(entity);
  return entity;
}

/**
 * Get-or-create the canonical entity for a referenced object (used by promotion to build
 * the provenance graph). Idempotent on the canonical key.
 */
export function ensureCanonicalEntity(db: FounderDb, type: BrainEntityType, ref: CanonicalRef, fallbackName: string): BrainEntity {
  const existing = db.brainEntities.getByCanonicalKey(canonicalKey(ref.kind, ref.id));
  if (existing) return existing;
  const name = resolveCanonicalRef(db, ref) ?? fallbackName;
  const entity: BrainEntity = {
    id: `bent-${randomUUID()}`,
    type,
    name,
    canonicalRef: ref,
    createdAt: now(),
    updatedAt: now(),
  };
  db.brainEntities.insert(entity);
  return entity;
}

export function getEntity(db: FounderDb, id: string): BrainEntity | null {
  return db.brainEntities.get(id);
}

export function listEntities(db: FounderDb, type?: string): BrainEntity[] {
  return db.brainEntities.list(type);
}
