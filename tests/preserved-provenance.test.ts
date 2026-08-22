/**
 * Preserved provenance to a deleted canonical artifact (Architecture V2 · preserved
 * provenance). Mission cleanup deletes the Company Artifact but KEEPS promoted G-Brain
 * knowledge/sources/entities — so a canonicalRef can honestly point at a deleted object.
 * The entity resolves as `missing`, the Inspector shows a `source_deleted` view (never a
 * fabricated artifact), knowledge + relationships survive, and no content leaks.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '@/lib/db';
import { createCustomAgent } from '@/lib/agents/custom';
import { createMission, createCompanyTask } from '@/lib/company/service';
import { createArtifact } from '@/lib/company/manager/artifacts';
import { promoteArtifactToBrain } from '@/lib/brain/core/promote';
import { deleteTestMission } from '@/lib/company/cleanup/service';
import { getArtifact } from '@/lib/company/manager/artifacts';
import { getEntity } from '@/lib/brain/core/entities';
import { getKnowledge } from '@/lib/brain/core/knowledge';
import { neighborhood } from '@/lib/brain/core/relationships';
import { canonicalRefState } from '@/lib/brain/core/provenance';
import { canonicalKey, BrainError } from '@/lib/brain/core/model';
import { inspectEntity } from '@/lib/brain/inspector/service';

const RAW_BODY = 'RAW-ARTIFACT-BODY-should-not-be-reconstructed';

/** Build mission→task→artifact, promote to G-Brain, then delete the mission (keeps knowledge). */
function setupDeletedArtifact() {
  const db = openDb(':memory:');
  const agent = createCustomAgent(db, { name: 'AI Scope Analyst', departmentId: 'dept-tech', instructions: 'x', model: '', tools: [], enabled: true });
  const mission = createMission(db, { title: 'TOP AI UPDATE DAILY BRIEF' });
  const task = createCompanyTask(db, mission.id, { title: 'Define Top AI Scope', requiredCapabilities: ['research.market'] });
  const artifact = createArtifact(db, {
    missionId: mission.id,
    taskId: task.id,
    producedByAgentId: agent.id,
    type: 'agent_result',
    title: 'Define Top AI Scope — result',
    summary: 'a summary',
    content: RAW_BODY,
    contentType: 'text/plain',
    sourceRefs: ['run-1'],
  });
  const promo = promoteArtifactToBrain(db, artifact.id);
  const entity = db.brainEntities.getByCanonicalKey(canonicalKey('artifact', artifact.id))!;
  const knowledgeBefore = db.brainKnowledge.all().length;

  deleteTestMission(db, mission.id, { confirm: true });
  return { db, agent, artifact, promo, entity, knowledgeBefore };
}

describe('canonical resolution state', () => {
  it('is live for an existing object and missing for a deleted one', () => {
    const { db, artifact } = setupDeletedArtifact();
    expect(getArtifact(db, artifact.id) ?? null).toBeNull(); // artifact was deleted by cleanup
    expect(canonicalRefState(db, { kind: 'artifact', id: artifact.id })).toBe('missing');
    // a live agent still resolves
    const anyAgent = db.customAgents.all()[0];
    expect(canonicalRefState(db, { kind: 'agent', id: anyAgent.id })).toBe('live');
  });
});

describe('mission cleanup preserves durable knowledge', () => {
  it('deletes the artifact but keeps the promoted knowledge + entity + relationships', () => {
    const { db, promo, entity, knowledgeBefore } = setupDeletedArtifact();
    // knowledge preserved
    expect(db.brainKnowledge.all().length).toBe(knowledgeBefore);
    expect(getKnowledge(db, promo.knowledge.id)).not.toBeNull();
    // entity preserved with its (now-dangling) canonical ref intact
    expect(getEntity(db, entity.id)).not.toBeNull();
    expect(entity.canonicalRef?.kind).toBe('artifact');
    // relationships intact: Knowledge DERIVED_FROM + Task/Agent PRODUCED
    const nb = neighborhood(db, entity.id);
    const types = nb.relationships.map((r) => r.type);
    expect(types).toContain('DERIVED_FROM');
    expect(types).toContain('PRODUCED');
    expect(nb.relationships.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Inspector: deleted artifact with preserved provenance', () => {
  it('returns an honest source_deleted view instead of throwing', () => {
    const { db, artifact } = setupDeletedArtifact();
    const view = inspectEntity(db, { kind: 'artifact', id: artifact.id });
    expect(view.entity.status).toBe('source_deleted');
    const overview = view.sections.find((s) => s.title === 'Overview')!;
    expect(overview.rows.some((r) => r.value === 'source_deleted')).toBe(true);
    expect(JSON.stringify(view)).toMatch(/no longer available/);
    // preserved provenance edges are surfaced
    const provenance = view.sections.find((s) => s.title === 'Preserved provenance')!;
    expect(provenance.rows.length).toBeGreaterThan(0);
  });

  it('never reconstructs the deleted artifact or exposes its content', () => {
    const { db, artifact } = setupDeletedArtifact();
    const view = inspectEntity(db, { kind: 'artifact', id: artifact.id });
    const json = JSON.stringify(view);
    expect(json).not.toContain(RAW_BODY); // the raw artifact body is never resurfaced
    expect(json).not.toMatch(/API_KEY|SECRET|token|password/i);
  });

  it('a truly-unknown artifact id is still a real 404', () => {
    const db = openDb(':memory:');
    try {
      inspectEntity(db, { kind: 'artifact', id: 'artifact-does-not-exist' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BrainError);
      expect((e as BrainError).status).toBe(404);
    }
  });
});
