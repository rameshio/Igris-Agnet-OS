/**
 * G-Brain Core — Search (Architecture V2 · F3).
 *
 * Deterministic keyword search over canonical G-Brain knowledge — entity names, knowledge
 * titles + content, and source titles. Case-insensitive substring; bounded result count.
 * NO vector DB and NO Neo4j: the baseline is keyword-only and works without any embedding
 * model. (The existing lexical `embedText` in lib/brain-graph.ts remains available as an
 * optional ranker; F3 does not depend on it.)
 */
import type { FounderDb } from '@/lib/db';
import { snippet, type BrainEntityType } from '@/lib/brain/core/model';

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;

export type BrainSearchHit =
  | { kind: 'entity'; id: string; title: string; entityType: BrainEntityType }
  | { kind: 'knowledge'; id: string; title: string; snippet: string }
  | { kind: 'source'; id: string; title: string };

/** Keyword search across entities, knowledge, and sources. Bounded, deterministic. */
export function searchBrain(db: FounderDb, query: string, limit = SEARCH_LIMIT_DEFAULT): BrainSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const cap = Math.max(1, Math.min(limit, SEARCH_LIMIT_MAX));
  const hits: BrainSearchHit[] = [];

  for (const e of db.brainEntities.all()) {
    if (e.name.toLowerCase().includes(needle) || (e.summary?.toLowerCase().includes(needle) ?? false)) {
      hits.push({ kind: 'entity', id: e.id, title: e.name, entityType: e.type });
    }
  }
  for (const k of db.brainKnowledge.all()) {
    const inTitle = k.title.toLowerCase().includes(needle);
    const inContent = k.content.toLowerCase().includes(needle);
    if (inTitle || inContent) {
      hits.push({ kind: 'knowledge', id: k.id, title: k.title, snippet: snippet(inContent ? k.content : k.title, needle) });
    }
  }
  for (const s of db.brainSources.all()) {
    if (s.title?.toLowerCase().includes(needle)) hits.push({ kind: 'source', id: s.id, title: s.title });
  }

  return hits.slice(0, cap);
}
