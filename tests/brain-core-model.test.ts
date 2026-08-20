/**
 * G-Brain Core — pure model tests (Architecture V2 · F3).
 *
 * The enums, canonical-key rule, source URL validation, and safe projections are pure
 * (no DB/LLM), so the load-bearing guarantees — closed types, nullable-never-fabricated
 * confidence, and projections that never leak knowledge content — are proven without SQLite.
 */
import { describe, it, expect } from 'vitest';
import {
  BrainEntityInputSchema,
  BrainKnowledgeInputSchema,
  BrainRelationshipInputSchema,
  BrainSourceInputSchema,
  canonicalKey,
  safeEntity,
  safeKnowledge,
  selfLinkAllowed,
  snippet,
  type BrainEntity,
  type BrainKnowledge,
} from '@/lib/brain/core/model';

describe('canonicalKey', () => {
  it('builds a deterministic kind:id key', () => {
    expect(canonicalKey('agent', 'custom-123')).toBe('agent:custom-123');
    expect(canonicalKey('mission', 'm-1')).toBe('mission:m-1');
  });
});

describe('BrainEntityInputSchema', () => {
  it('accepts a valid entity and a canonical ref', () => {
    const e = BrainEntityInputSchema.parse({ type: 'concept', name: 'Doc workflows', canonicalRef: { kind: 'mission', id: 'm-1' } });
    expect(e.type).toBe('concept');
    expect(e.canonicalRef).toEqual({ kind: 'mission', id: 'm-1' });
  });
  it('rejects an invalid entity type', () => {
    expect(() => BrainEntityInputSchema.parse({ type: 'galaxy', name: 'x' })).toThrow();
  });
  it('rejects an invalid canonical ref kind', () => {
    expect(() => BrainEntityInputSchema.parse({ type: 'agent', name: 'x', canonicalRef: { kind: 'planet', id: '1' } })).toThrow();
  });
});

describe('BrainRelationshipInputSchema', () => {
  it('accepts a known relationship type', () => {
    expect(BrainRelationshipInputSchema.parse({ fromEntityId: 'a', toEntityId: 'b', type: 'ABOUT' }).type).toBe('ABOUT');
  });
  it('rejects an unknown relationship type', () => {
    expect(() => BrainRelationshipInputSchema.parse({ fromEntityId: 'a', toEntityId: 'b', type: 'LOVES' })).toThrow();
  });
  it('bounds metadata to safe scalars and 12 keys', () => {
    const big = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, '1']));
    expect(() => BrainRelationshipInputSchema.parse({ fromEntityId: 'a', toEntityId: 'b', type: 'RELATED_TO', metadata: big })).toThrow();
  });
});

describe('self-link policy', () => {
  it('allows RELATED_TO to self-link, forbids the rest', () => {
    expect(selfLinkAllowed('RELATED_TO')).toBe(true);
    expect(selfLinkAllowed('DERIVED_FROM')).toBe(false);
    expect(selfLinkAllowed('PRODUCED')).toBe(false);
  });
});

describe('BrainKnowledgeInputSchema', () => {
  it('defaults kind to note and leaves confidence unset (never fabricated)', () => {
    const k = BrainKnowledgeInputSchema.parse({ title: 'T', content: 'C' });
    expect(k.kind).toBe('note');
    expect(k.confidence).toBeUndefined();
  });
  it('accepts an explicit null confidence', () => {
    expect(BrainKnowledgeInputSchema.parse({ title: 'T', content: 'C', confidence: null }).confidence).toBeNull();
  });
  it('rejects an invalid knowledge kind', () => {
    expect(() => BrainKnowledgeInputSchema.parse({ title: 'T', content: 'C', kind: 'rumor' })).toThrow();
  });
});

describe('BrainSourceInputSchema', () => {
  it('requires a valid http(s) uri for a url source', () => {
    expect(() => BrainSourceInputSchema.parse({ type: 'url' })).toThrow();
    expect(() => BrainSourceInputSchema.parse({ type: 'url', uri: 'not a url' })).toThrow();
    expect(BrainSourceInputSchema.parse({ type: 'url', uri: 'https://example.com/x' }).uri).toBe('https://example.com/x');
  });
  it('allows a non-url source without a uri', () => {
    expect(BrainSourceInputSchema.parse({ type: 'document', title: 'Notes' }).type).toBe('document');
  });
});

describe('safe projections', () => {
  it('safeKnowledge omits the full content', () => {
    const k: BrainKnowledge = {
      id: 'k1', title: 'T', content: 'SECRET FULL BODY', summary: 's', kind: 'finding',
      confidence: null, status: 'active', createdAt: 'now', updatedAt: 'now',
    };
    const safe = safeKnowledge(k);
    expect('content' in safe).toBe(false);
    expect(JSON.stringify(safe)).not.toMatch(/SECRET FULL BODY/);
    expect(safe.title).toBe('T');
  });
  it('safeEntity keeps only identity/labels (no secret fields exist on entities)', () => {
    const e: BrainEntity = { id: 'e1', type: 'agent', name: 'Scout', canonicalRef: { kind: 'agent', id: 'a1' }, createdAt: 'now', updatedAt: 'now' };
    expect(safeEntity(e)).toEqual(e);
  });
});

describe('snippet', () => {
  it('returns a bounded snippet around the match', () => {
    const s = snippet('a'.repeat(50) + 'NEEDLE' + 'b'.repeat(300), 'needle');
    expect(s.length).toBeLessThanOrEqual(162);
    expect(s.toLowerCase()).toContain('needle');
  });
});
