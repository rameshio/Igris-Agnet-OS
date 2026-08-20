/**
 * G-Brain Core — Artifact → Brain promotion tests (Architecture V2 · F3).
 *
 * Promotion is EXPLICIT and IDEMPOTENT: it creates a Source + Knowledge + a provenance
 * graph by canonical reference, never modifies the artifact, never auto-ingests any other
 * artifact, and its safe list projection never leaks the artifact's full content.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '@/lib/db';
import { createCustomAgent } from '@/lib/agents/custom';
import { createMission, createCompanyTask } from '@/lib/company/service';
import { createArtifact } from '@/lib/company/manager/artifacts';
import { promoteArtifactToBrain } from '@/lib/brain/core/promote';
import { listKnowledge } from '@/lib/brain/core/knowledge';
import { canonicalKey } from '@/lib/brain/core/model';

type DB = ReturnType<typeof openDb>;

function setup(db: DB) {
  const agent = createCustomAgent(db, { name: 'Scout', departmentId: 'dept-tech', instructions: 'x', model: '', tools: [], enabled: true });
  const mission = createMission(db, { title: 'Market study' });
  const task = createCompanyTask(db, mission.id, { title: 'Analyze the market' });
  const artifact = createArtifact(db, {
    missionId: mission.id,
    taskId: task.id,
    producedByAgentId: agent.id,
    type: 'agent_result',
    title: 'Market findings',
    summary: 'Accounting firms rely on repetitive document workflows.',
    content: 'Full research body: accounting firms rely on repetitive document workflows and want automation.',
  });
  return { agent, mission, task, artifact };
}

describe('promoteArtifactToBrain', () => {
  it('creates a source + knowledge + provenance, and leaves the artifact unchanged', () => {
    const db = openDb(':memory:');
    const { agent, mission, task, artifact } = setup(db);
    const before = JSON.stringify(db.companyArtifacts.get(artifact.id));

    const { source, knowledge, created } = promoteArtifactToBrain(db, artifact.id);

    expect(created).toBe(true);
    expect(source.type).toBe('artifact');
    expect(source.canonicalRef).toEqual({ kind: 'artifact', id: artifact.id });
    expect(knowledge.sourceId).toBe(source.id);
    expect(knowledge.createdByAgentId).toBe(agent.id);
    expect(knowledge.content).toContain('automation');

    // Artifact is untouched (canonical in Company Core).
    expect(JSON.stringify(db.companyArtifacts.get(artifact.id))).toBe(before);

    // Provenance graph resolves: knowledge ← artifact ← task ← mission (+ agent produced).
    const artifactEntity = db.brainEntities.getByCanonicalKey(canonicalKey('artifact', artifact.id))!;
    const taskEntity = db.brainEntities.getByCanonicalKey(canonicalKey('company_task', task.id))!;
    const missionEntity = db.brainEntities.getByCanonicalKey(canonicalKey('mission', mission.id))!;
    const agentEntity = db.brainEntities.getByCanonicalKey(canonicalKey('agent', agent.id))!;
    expect(artifactEntity && taskEntity && missionEntity && agentEntity).toBeTruthy();
    const edges = db.brainRelationships.all().map((r) => r.type);
    expect(edges).toEqual(expect.arrayContaining(['DERIVED_FROM', 'PRODUCED', 'HAS_TASK']));
  });

  it('is idempotent — a second promotion creates no duplicate source/knowledge', () => {
    const db = openDb(':memory:');
    const { artifact } = setup(db);
    const first = promoteArtifactToBrain(db, artifact.id);
    const second = promoteArtifactToBrain(db, artifact.id);

    expect(second.created).toBe(false);
    expect(second.source.id).toBe(first.source.id);
    expect(second.knowledge.id).toBe(first.knowledge.id);
    expect(db.brainSources.all()).toHaveLength(1);
    expect(db.brainKnowledge.all()).toHaveLength(1);
  });

  it('does NOT auto-ingest other artifacts', () => {
    const db = openDb(':memory:');
    const { mission, task, artifact } = setup(db);
    createArtifact(db, { missionId: mission.id, taskId: task.id, type: 'agent_result', title: 'Other', content: 'other body' });

    promoteArtifactToBrain(db, artifact.id); // promote only the first

    expect(db.brainKnowledge.all()).toHaveLength(1); // the other artifact was NOT ingested
  });

  it('the safe knowledge list projection excludes the artifact content', () => {
    const db = openDb(':memory:');
    const { artifact } = setup(db);
    promoteArtifactToBrain(db, artifact.id);
    expect(JSON.stringify(listKnowledge(db))).not.toMatch(/Full research body/);
  });

  it('rejects promoting an unknown artifact', () => {
    const db = openDb(':memory:');
    expect(() => promoteArtifactToBrain(db, 'artifact-nope')).toThrow(/not found/);
  });
});
