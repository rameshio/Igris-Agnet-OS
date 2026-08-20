/**
 * G-Brain Core — service tests (Architecture V2 · F3), over the real repos.
 *
 * Proves canonical-ref validation + uniqueness (no state copied, no duplicate canonical
 * entity), relationship safety (endpoints/self-link/idempotency/safe metadata), knowledge
 * provenance (nullable confidence, safe projection), source resolution, bounded keyword
 * search, and that G-Brain writes NEVER touch the other canonical systems.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '@/lib/db';
import { createCustomAgent } from '@/lib/agents/custom';
import { createMission, createCompanyTask } from '@/lib/company/service';
import { createArtifact } from '@/lib/company/manager/artifacts';
import { createEntity, getEntity, listEntities } from '@/lib/brain/core/entities';
import { createRelationship, neighborhood } from '@/lib/brain/core/relationships';
import { createKnowledge, updateKnowledge, getKnowledge, listKnowledge } from '@/lib/brain/core/knowledge';
import { createSource } from '@/lib/brain/core/sources';
import { searchBrain, SEARCH_LIMIT_MAX } from '@/lib/brain/core/search';

type DB = ReturnType<typeof openDb>;
const concept = (db: DB, name: string) => createEntity(db, { type: 'concept', name });

describe('entities', () => {
  it('creates a brain-native entity with a server-generated id', () => {
    const db = openDb(':memory:');
    const e = concept(db, 'Document workflows');
    expect(e.id).toMatch(/^bent-/);
    expect(getEntity(db, e.id)?.name).toBe('Document workflows');
    expect(listEntities(db, 'concept')).toHaveLength(1);
  });

  it('validates a canonical ref against its owning system and stores no copied state', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'Q3 launch' });
    const e = createEntity(db, { type: 'mission', name: 'Q3 launch (ref)', canonicalRef: { kind: 'mission', id: m.id } });
    expect(e.canonicalRef).toEqual({ kind: 'mission', id: m.id });
    // Only id + name/summary are stored — never mission status/priority/etc.
    expect(Object.keys(e)).toEqual(expect.arrayContaining(['id', 'type', 'name', 'canonicalRef']));
    expect(JSON.stringify(e)).not.toMatch(/priority|status/);
  });

  it('rejects an unknown canonical ref', () => {
    const db = openDb(':memory:');
    expect(() => createEntity(db, { type: 'mission', name: 'ghost', canonicalRef: { kind: 'mission', id: 'nope' } })).toThrow(/not found/);
  });

  it('is idempotent per canonical ref — no duplicate canonical entity', () => {
    const db = openDb(':memory:');
    const a = createCustomAgent(db, { name: 'Scout', departmentId: 'dept-tech', instructions: 'x', model: '', tools: [], enabled: true });
    const e1 = createEntity(db, { type: 'agent', name: 'Scout', canonicalRef: { kind: 'agent', id: a.id } });
    const e2 = createEntity(db, { type: 'agent', name: 'Scout again', canonicalRef: { kind: 'agent', id: a.id } });
    expect(e2.id).toBe(e1.id);
    expect(listEntities(db, 'agent')).toHaveLength(1);
  });
});

describe('relationships', () => {
  it('creates an edge and returns it in the neighborhood', () => {
    const db = openDb(':memory:');
    const k = concept(db, 'Knowledge node');
    const c = concept(db, 'A concept');
    const rel = createRelationship(db, { fromEntityId: k.id, toEntityId: c.id, type: 'ABOUT' });
    const n = neighborhood(db, k.id);
    expect(n.relationships.map((r) => r.id)).toContain(rel.id);
    expect(n.neighbors.map((e) => e.id)).toContain(c.id);
  });

  it('is idempotent on (from, to, type)', () => {
    const db = openDb(':memory:');
    const a = concept(db, 'A');
    const b = concept(db, 'B');
    const r1 = createRelationship(db, { fromEntityId: a.id, toEntityId: b.id, type: 'RELATED_TO' });
    const r2 = createRelationship(db, { fromEntityId: a.id, toEntityId: b.id, type: 'RELATED_TO' });
    expect(r2.id).toBe(r1.id);
    expect(db.brainRelationships.all()).toHaveLength(1);
  });

  it('rejects a missing endpoint', () => {
    const db = openDb(':memory:');
    const a = concept(db, 'A');
    expect(() => createRelationship(db, { fromEntityId: a.id, toEntityId: 'ghost', type: 'RELATED_TO' })).toThrow(/not found/);
  });

  it('rejects a self-link for a type that disallows it', () => {
    const db = openDb(':memory:');
    const a = concept(db, 'A');
    expect(() => createRelationship(db, { fromEntityId: a.id, toEntityId: a.id, type: 'DERIVED_FROM' })).toThrow(/self-link/);
    // RELATED_TO may self-link
    expect(createRelationship(db, { fromEntityId: a.id, toEntityId: a.id, type: 'RELATED_TO' }).fromEntityId).toBe(a.id);
  });
});

describe('knowledge', () => {
  it('creates knowledge with provenance and never fabricates confidence', () => {
    const db = openDb(':memory:');
    const src = createSource(db, { type: 'user', title: 'Operator note' });
    const k = createKnowledge(db, { title: 'Accounting fact', content: 'Firms rely on repetitive document workflows.', kind: 'fact', sourceId: src.id });
    expect(k.confidence).toBeNull();
    expect(k.sourceId).toBe(src.id);
    expect(getKnowledge(db, k.id)?.content).toContain('repetitive');
  });

  it('rejects an invalid kind and a missing source', () => {
    const db = openDb(':memory:');
    expect(() => createKnowledge(db, { title: 'T', content: 'C', kind: 'rumor' })).toThrow();
    expect(() => createKnowledge(db, { title: 'T', content: 'C', sourceId: 'ghost' })).toThrow(/source not found/);
  });

  it('updates knowledge and the list projection excludes content', () => {
    const db = openDb(':memory:');
    const k = createKnowledge(db, { title: 'T', content: 'FULL BODY TEXT' });
    updateKnowledge(db, k.id, { status: 'archived', summary: 'short' });
    expect(getKnowledge(db, k.id)?.status).toBe('archived');
    const listed = listKnowledge(db);
    expect(JSON.stringify(listed)).not.toMatch(/FULL BODY TEXT/);
  });
});

describe('sources', () => {
  it('resolves an artifact canonical ref', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'T' });
    const a = createArtifact(db, { missionId: m.id, taskId: t.id, type: 'agent_result', title: 'Result', content: 'body' });
    const src = createSource(db, { type: 'artifact', title: a.title, canonicalRef: { kind: 'artifact', id: a.id } });
    expect(src.canonicalRef).toEqual({ kind: 'artifact', id: a.id });
  });

  it('rejects a source referencing an unknown canonical object', () => {
    const db = openDb(':memory:');
    expect(() => createSource(db, { type: 'artifact', canonicalRef: { kind: 'artifact', id: 'ghost' } })).toThrow(/not found/);
  });
});

describe('search', () => {
  it('matches entity name, knowledge title, and knowledge content; bounded; no-match empty', () => {
    const db = openDb(':memory:');
    concept(db, 'Repetitive workflows');
    createKnowledge(db, { title: 'Doc automation', content: 'accounting firms rely on repetitive processes' });
    expect(searchBrain(db, 'repetitive').length).toBeGreaterThanOrEqual(2);
    expect(searchBrain(db, 'automation').some((h) => h.kind === 'knowledge')).toBe(true);
    expect(searchBrain(db, 'accounting').some((h) => h.kind === 'knowledge')).toBe(true);
    expect(searchBrain(db, 'zzzznomatch')).toEqual([]);
  });

  it('caps results at the max limit', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < SEARCH_LIMIT_MAX + 10; i++) concept(db, `match-${i}`);
    expect(searchBrain(db, 'match', 999).length).toBe(SEARCH_LIMIT_MAX);
  });
});

describe('separation from other canonical systems', () => {
  it('brain writes never touch company events, missions, tasks, or the agent registry', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const t = createCompanyTask(db, m.id, { title: 'T' });
    const agentsBefore = db.customAgents.all().length;
    const eventsBefore = db.companyEvents.forMission(m.id).length;

    const e = concept(db, 'A concept');
    createRelationship(db, { fromEntityId: e.id, toEntityId: concept(db, 'B').id, type: 'RELATED_TO' });
    createKnowledge(db, { title: 'K', content: 'body' });

    expect(db.companyEvents.forMission(m.id).length).toBe(eventsBefore); // no ledger writes
    expect(db.customAgents.all().length).toBe(agentsBefore); // registry untouched
    expect(db.companyTasks.get(t.id)?.status).toBe('queued'); // task state untouched
  });
});
