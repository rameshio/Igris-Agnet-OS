/**
 * Workspace reset — the "start clean" seam.
 *
 * A demo instance boots seeded with a whole fake business. To hand the OS to a
 * real client, an operator resets it: either clear just the accumulated
 * activity logs, or clear the demo business data entirely and mark the instance
 * so the seeder never brings it back (see lib/data.ts). Neither scope touches
 * the structural scaffolding or any client-created custom agent.
 */
import { z } from 'zod';
import type { FounderDb } from '@/lib/db';

export const ResetScopeSchema = z.enum(['activity', 'demo']);
export type ResetScope = z.infer<typeof ResetScopeSchema>;

export type ResetResult = { scope: ResetScope; demoCleared: boolean; summary: string };

export function resetWorkspace(db: FounderDb, scope: ResetScope): ResetResult {
  if (scope === 'activity') {
    db.maintenance.clearActivity();
    return {
      scope,
      demoCleared: db.meta.get('demo_cleared') === '1',
      summary: 'Cleared runs, chats, tasks, crons, and other activity logs. Demo content kept.',
    };
  }
  db.maintenance.clearDemoContent();
  return {
    scope,
    demoCleared: true,
    summary: 'Cleared the demo business data and activity. This is now a clean client workspace.',
  };
}
