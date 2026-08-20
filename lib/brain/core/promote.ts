/**
 * G-Brain Core — Artifact → Brain promotion (Architecture V2 · F3).
 *
 * The ONE explicit seam that turns a company Artifact (F1) into durable G-Brain knowledge
 * with provenance. It is EXPLICIT and IDEMPOTENT: one promotion per artifact. It NEVER
 * modifies the artifact (which stays canonical in Company Core), and NEVER auto-ingests
 * any other artifact. The artifact is REFERENCED (canonical ref + provenance), not copied
 * into a competing object.
 *
 * It builds the provenance graph by canonical reference so the chain is answerable:
 *   Knowledge ─DERIVED_FROM→ Artifact  ·  Agent ─PRODUCED→ Artifact  ·
 *   Task ─PRODUCED→ Artifact  ·  Mission ─HAS_TASK→ Task
 * plus Knowledge.sourceId → Source(artifact) → canonicalRef → the artifact itself.
 */
import type { FounderDb } from '@/lib/db';
import { getArtifact } from '@/lib/company/manager/artifacts';
import { createSource } from '@/lib/brain/core/sources';
import { createKnowledge } from '@/lib/brain/core/knowledge';
import { ensureCanonicalEntity } from '@/lib/brain/core/entities';
import { createRelationship } from '@/lib/brain/core/relationships';
import { BrainError, canonicalKey, type BrainKnowledge, type BrainSource, type KnowledgeKind } from '@/lib/brain/core/model';

export type PromoteResult = { source: BrainSource; knowledge: BrainKnowledge; created: boolean };

/**
 * Promote one artifact into G-Brain. Idempotent: a second call returns the existing
 * source + knowledge (`created: false`) and creates no duplicates.
 */
export function promoteArtifactToBrain(db: FounderDb, artifactId: string, opts: { title?: string; kind?: KnowledgeKind } = {}): PromoteResult {
  const artifact = getArtifact(db, artifactId);
  if (!artifact) throw new BrainError('artifact not found', 404);

  // Idempotency: one Source per artifact canonical ref → one promotion.
  const existingSource = db.brainSources.getByCanonicalKey(canonicalKey('artifact', artifact.id));
  if (existingSource) {
    const existingKnowledge = db.brainKnowledge.bySource(existingSource.id)[0];
    if (existingKnowledge) return { source: existingSource, knowledge: existingKnowledge, created: false };
  }

  // 1. Provenance source (references the artifact; never copies it).
  const source =
    existingSource ??
    createSource(db, { type: 'artifact', title: artifact.title, canonicalRef: { kind: 'artifact', id: artifact.id } });

  // 2. Durable knowledge from the artifact's content (falls back to summary/title).
  const rawContent = typeof artifact.content === 'string' && artifact.content.trim() ? artifact.content : artifact.summary ?? artifact.title;
  const knowledge = createKnowledge(db, {
    title: opts.title ?? artifact.title,
    content: (rawContent || artifact.title).slice(0, 20_000),
    summary: artifact.summary,
    kind: opts.kind ?? 'finding',
    sourceId: source.id,
    createdByAgentId: artifact.producedByAgentId,
  });

  // 3. Provenance graph, by canonical reference (idempotent get-or-create + edges).
  const knowledgeEntity = ensureCanonicalEntity(db, 'knowledge', { kind: 'knowledge', id: knowledge.id }, knowledge.title);
  const artifactEntity = ensureCanonicalEntity(db, 'artifact', { kind: 'artifact', id: artifact.id }, artifact.title);
  createRelationship(db, { fromEntityId: knowledgeEntity.id, toEntityId: artifactEntity.id, type: 'DERIVED_FROM', sourceId: source.id });

  if (artifact.taskId) {
    const taskEntity = ensureCanonicalEntity(db, 'task', { kind: 'company_task', id: artifact.taskId }, `task ${artifact.taskId}`);
    createRelationship(db, { fromEntityId: taskEntity.id, toEntityId: artifactEntity.id, type: 'PRODUCED' });
    if (artifact.missionId) {
      const missionEntity = ensureCanonicalEntity(db, 'mission', { kind: 'mission', id: artifact.missionId }, `mission ${artifact.missionId}`);
      createRelationship(db, { fromEntityId: missionEntity.id, toEntityId: taskEntity.id, type: 'HAS_TASK' });
    }
  }
  if (artifact.producedByAgentId) {
    const agentEntity = ensureCanonicalEntity(db, 'agent', { kind: 'agent', id: artifact.producedByAgentId }, artifact.producedByAgentId);
    createRelationship(db, { fromEntityId: agentEntity.id, toEntityId: artifactEntity.id, type: 'PRODUCED' });
  }

  return { source, knowledge, created: true };
}
