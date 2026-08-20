/**
 * G-Brain Core — Knowledge service (Architecture V2 · F3).
 *
 * Durable, explicit company knowledge (fact/note/decision/finding/procedure/reference)
 * with optional provenance (`sourceId`) and creator. Confidence is nullable and NEVER
 * fabricated. List/feed reads use the SAFE projection (no full content); a single read
 * returns the full record. Persistence is EXPLICIT only — nothing auto-writes here.
 */
import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import {
  BrainKnowledgeInputSchema,
  BrainKnowledgeUpdateSchema,
  BrainError,
  safeKnowledge,
  type BrainKnowledge,
  type SafeBrainKnowledge,
} from '@/lib/brain/core/model';

const now = (): string => new Date().toISOString();

export function createKnowledge(db: FounderDb, input: unknown): BrainKnowledge {
  const parsed = BrainKnowledgeInputSchema.parse(input);
  if (parsed.sourceId && !db.brainSources.get(parsed.sourceId)) throw new BrainError('source not found', 404);

  const knowledge: BrainKnowledge = {
    id: `bkno-${randomUUID()}`,
    title: parsed.title,
    content: parsed.content,
    summary: parsed.summary,
    kind: parsed.kind,
    confidence: parsed.confidence ?? null, // never fabricated
    sourceId: parsed.sourceId,
    createdByAgentId: parsed.createdByAgentId,
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
  };
  db.brainKnowledge.insert(knowledge);
  return knowledge;
}

export function updateKnowledge(db: FounderDb, id: string, patch: unknown): BrainKnowledge {
  const existing = db.brainKnowledge.get(id);
  if (!existing) throw new BrainError('knowledge not found', 404);
  const parsed = BrainKnowledgeUpdateSchema.parse(patch);
  const updated: BrainKnowledge = { ...existing, ...parsed, updatedAt: now() };
  db.brainKnowledge.insert(updated);
  return updated;
}

/** Full record (includes content). */
export function getKnowledge(db: FounderDb, id: string): BrainKnowledge | null {
  return db.brainKnowledge.get(id);
}

/** Safe list projection — NO full content (a detail read returns it). */
export function listKnowledge(db: FounderDb): SafeBrainKnowledge[] {
  return db.brainKnowledge.all().map(safeKnowledge);
}
