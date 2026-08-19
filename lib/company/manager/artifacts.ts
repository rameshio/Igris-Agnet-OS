/**
 * Company Artifact service (Architecture V2 · F1) — the first-class structured
 * work product. Traceable to Mission/Task/execution (agent run OR workflow run)
 * for Manager synthesis and a FUTURE G-Brain ingestion seam.
 *
 * F1 does NOT auto-write artifact content into G-Brain — there is NO automatic
 * durable memory here (that is F3). Broad summary feeds must use the SAFE
 * projection (`missionArtifacts`), never the full `content`.
 */
import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import {
  CompanyArtifactInputSchema,
  safeArtifactSummary,
  type CompanyArtifact,
  type CompanyArtifactInput,
  type SafeArtifactSummary,
} from '@/lib/company/manager/model';

export function createArtifact(db: FounderDb, input: CompanyArtifactInput): CompanyArtifact {
  const parsed = CompanyArtifactInputSchema.parse(input);
  const artifact: CompanyArtifact = { id: `artifact-${randomUUID()}`, ...parsed, createdAt: new Date().toISOString() };
  db.companyArtifacts.insert(artifact); // NO G-Brain ingestion (F3)
  return artifact;
}

export function getArtifact(db: FounderDb, id: string): CompanyArtifact | null {
  return db.companyArtifacts.get(id);
}

/** SAFE summaries for a mission (no artifact content). */
export function missionArtifacts(db: FounderDb, missionId: string): SafeArtifactSummary[] {
  return db.companyArtifacts.forMission(missionId).map(safeArtifactSummary);
}

export function taskArtifacts(db: FounderDb, taskId: string): CompanyArtifact[] {
  return db.companyArtifacts.forTask(taskId);
}
