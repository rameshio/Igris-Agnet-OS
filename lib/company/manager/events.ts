/**
 * Company Event ledger (Architecture V2 · F1) — append-only operational events for
 * real delegation. NOT canonical state (Mission/Task/Artifact/Run/Agent remain the
 * source of truth). Events are emitted ONLY AFTER an authoritative state change
 * persists, and logging is BEST-EFFORT: a ledger failure must never corrupt or roll
 * back canonical company state (it is swallowed, not thrown).
 */
import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import { CompanyEventInputSchema, type CompanyEvent, type CompanyEventInput } from '@/lib/company/manager/model';

/** Append one event. Returns the row, or null if validation/write failed (best-effort). */
export function appendEvent(db: FounderDb, input: CompanyEventInput): CompanyEvent | null {
  try {
    const parsed = CompanyEventInputSchema.parse(input);
    const event: CompanyEvent = { id: `evt-${randomUUID()}`, ...parsed, createdAt: new Date().toISOString() };
    db.companyEvents.append(event);
    return event;
  } catch {
    return null;
  }
}

export function listMissionEvents(db: FounderDb, missionId: string, limit = 200): CompanyEvent[] {
  return db.companyEvents.forMission(missionId, limit);
}
export function listTaskEvents(db: FounderDb, taskId: string, limit = 100): CompanyEvent[] {
  return db.companyEvents.forTask(taskId, limit);
}
