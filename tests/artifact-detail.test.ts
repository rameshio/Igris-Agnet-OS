/**
 * Artifact detail / "View Result" UX (Architecture V2 · consolidation follow-up).
 *
 * Proves the operator can read the FULL artifact result via an explicit per-artifact
 * detail read, while broad mission feeds stay content-free, provenance is correct,
 * viewing never promotes, and Promote-to-G-Brain stays explicit + idempotent.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '@/lib/db';
import { createMission, createCompanyTask } from '@/lib/company/service';
import { createArtifact, getArtifact, missionArtifacts } from '@/lib/company/manager/artifacts';
import { promoteArtifactToBrain } from '@/lib/brain/core/promote';
import { GET as artifactDetailGET } from '@/app/api/company-artifacts/[id]/route';

type DB = ReturnType<typeof openDb>;

function seed(db: DB) {
  const m = createMission(db, { title: 'Research about top AI' });
  const t = createCompanyTask(db, m.id, { title: 'Define Top AI Scope' });
  const art = createArtifact(db, {
    missionId: m.id,
    taskId: t.id,
    producedByAgentId: 'agent-x',
    type: 'agent_result',
    title: 'Define Top AI Scope — result',
    summary: 'the scope',
    content: 'FULL AGENT RESULT BODY',
  });
  return { m, t, art };
}

describe('artifact detail read (full result)', () => {
  it('returns the FULL content + complete provenance on an explicit detail read', () => {
    const db = openDb(':memory:');
    const { m, t, art } = seed(db);
    const full = getArtifact(db, art.id)!;
    expect(full.content).toBe('FULL AGENT RESULT BODY');
    expect(full.summary).toBe('the scope');
    expect(full.type).toBe('agent_result');
    expect(full.missionId).toBe(m.id);
    expect(full.taskId).toBe(t.id);
    expect(full.producedByAgentId).toBe('agent-x');
    expect(full.createdAt).toBeTruthy();
  });

  it('keeps structured JSON content as an object (renderable readably, never [object Object])', () => {
    const db = openDb(':memory:');
    const m = createMission(db, { title: 'M' });
    const art = createArtifact(db, { missionId: m.id, type: 'agent_result', title: 'structured', content: { scope: ['a', 'b'], score: 9 } });
    expect(getArtifact(db, art.id)!.content).toEqual({ scope: ['a', 'b'], score: 9 });
  });

  it('missing artifact → 404', async () => {
    const res = await artifactDetailGET(new Request('http://localhost/api/company-artifacts/nope'), { params: { id: 'nope' } });
    expect(res.status).toBe(404);
  });

  it('carries its OWN provenance — a detail read cannot be spoofed to claim another mission', () => {
    const db = openDb(':memory:');
    const a = createMission(db, { title: 'A' });
    const b = createMission(db, { title: 'B' });
    const artA = createArtifact(db, { missionId: a.id, type: 'agent_result', title: 'A result', content: 'x' });
    const full = getArtifact(db, artA.id)!;
    expect(full.missionId).toBe(a.id);
    expect(full.missionId).not.toBe(b.id);
  });

  it('exposes no hidden runtime/secret fields — only the safe artifact shape', () => {
    const db = openDb(':memory:');
    const { art } = seed(db);
    const full = getArtifact(db, art.id)! as Record<string, unknown>;
    for (const k of ['context_json', 'startingInput', 'toolArgs', 'systemPrompt', 'apiKey', 'token', 'prompt']) {
      expect(k in full).toBe(false);
    }
    expect(full.content).toBeTruthy(); // the intended output IS present
  });
});

describe('broad feeds stay content-free', () => {
  it('the mission artifact list (safe projection) EXCLUDES full content', () => {
    const db = openDb(':memory:');
    const { m } = seed(db);
    const list = missionArtifacts(db, m.id);
    expect(list.length).toBe(1);
    expect((list[0] as Record<string, unknown>).content).toBeUndefined();
    expect(JSON.stringify(list)).not.toMatch(/FULL AGENT RESULT BODY/);
    // …but keeps safe identifiers/labels for the row
    expect(list[0].title).toContain('Define Top AI Scope');
    expect(list[0].type).toBe('agent_result');
    expect(list[0].missionId).toBe(m.id);
  });
});

describe('viewing never promotes; Promote stays explicit + idempotent', () => {
  it('a detail read creates NO G-Brain knowledge (no auto-promote on view)', () => {
    const db = openDb(':memory:');
    const { art } = seed(db);
    const before = db.brainKnowledge.all().length;
    getArtifact(db, art.id); // "view"
    getArtifact(db, art.id);
    expect(db.brainKnowledge.all().length).toBe(before);
  });

  it('Promote to G-Brain remains explicit and idempotent (unchanged)', () => {
    const db = openDb(':memory:');
    const { art } = seed(db);
    const before = db.brainKnowledge.all().length;
    promoteArtifactToBrain(db, art.id);
    const after = db.brainKnowledge.all().length;
    expect(after).toBe(before + 1);
    promoteArtifactToBrain(db, art.id); // idempotent — no duplicate
    expect(db.brainKnowledge.all().length).toBe(after);
  });
});
