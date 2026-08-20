/**
 * G-Brain Core — Sources / provenance service (Architecture V2 · F3).
 *
 * A source answers "where did this come from?" — an artifact, a document, a URL, a user,
 * an agent, a workflow, or the system. A source may REFERENCE a canonical object (validated
 * against its owning system). Sources NEVER store credentials/auth — only a plain resource
 * URL and safe labels.
 */
import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import { resolveCanonicalRef } from '@/lib/brain/core/entities';
import { BrainSourceInputSchema, BrainError, type BrainSource } from '@/lib/brain/core/model';

const now = (): string => new Date().toISOString();

export function createSource(db: FounderDb, input: unknown): BrainSource {
  const parsed = BrainSourceInputSchema.parse(input);
  if (parsed.canonicalRef && resolveCanonicalRef(db, parsed.canonicalRef) === null) {
    throw new BrainError('canonical ref not found', 404);
  }
  const source: BrainSource = {
    id: `bsrc-${randomUUID()}`,
    type: parsed.type,
    title: parsed.title,
    canonicalRef: parsed.canonicalRef,
    uri: parsed.uri,
    createdAt: now(),
  };
  db.brainSources.insert(source);
  return source;
}

export function getSource(db: FounderDb, id: string): BrainSource | null {
  return db.brainSources.get(id);
}

export function listSources(db: FounderDb): BrainSource[] {
  return db.brainSources.all();
}
