/**
 * The full live agent roster = the code-defined built-ins (lib/agents/real.ts)
 * plus every client-created custom agent stored in the DB. Routes that run,
 * chat with, or broadcast to agents resolve against this combined set so a
 * custom agent is a first-class citizen everywhere a built-in is.
 */
import type { FounderDb } from '@/lib/db';
import { realAgents } from '@/lib/agents/real';
import { customRuntimeAgents } from '@/lib/agents/custom';
import type { RuntimeAgent } from '@/lib/agents/runtime';

export function allRuntimeAgents(db: FounderDb): RuntimeAgent[] {
  return [...realAgents, ...customRuntimeAgents(db)];
}
