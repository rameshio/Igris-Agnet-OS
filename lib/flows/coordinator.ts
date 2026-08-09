/**
 * FlowRunCoordinator (Phase C) — a tiny process-local runner. IGRIS is a
 * persistent local Next.js process, so a run executes in-process, fire-and-forget:
 * the API creates the run, the coordinator launches the engine and returns
 * immediately, and the UI polls the persisted run. No Redis/queue.
 *
 * Crash honesty: the set of in-flight run ids lives only in this process. After a
 * restart it is empty, so any run still marked `running` is stale — reconciled to
 * `interrupted` on read. We never report a stale run as successful.
 */
import type { FounderDb } from '@/lib/db';
import type { FlowRun } from '@/lib/flows/run-types';
import type { WorkflowGraph } from '@/lib/flows/schema';
import type { RuntimeAgent } from '@/lib/agents/runtime';
import { executeRun } from '@/lib/flows/engine';

// Next.js bundles each API route separately, so a plain module-level Set would
// NOT be shared between the POST (start) and GET (reconcile) routes. Pin the
// in-flight registry to globalThis so it is a single process-wide singleton.
declare global {
  // eslint-disable-next-line no-var
  var __igrisFlowActiveRuns: Set<string> | undefined;
}
const active: Set<string> = (globalThis.__igrisFlowActiveRuns ??= new Set<string>());

export function isActive(runId: string): boolean {
  return active.has(runId);
}

/** Launch a run in the background; resolves the run row synchronously to the caller. */
export function startRun(db: FounderDb, run: FlowRun, graph: WorkflowGraph, agents: RuntimeAgent[]): void {
  active.add(run.id);
  void executeRun(db, run, graph, agents)
    .catch((err) => {
      db.flowRuns.update(run.id, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        currentNodeId: null,
        errorCode: 'engine_error',
        errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    })
    .finally(() => active.delete(run.id));
}

/** On read: a `running` run not active in this process is stale → interrupted. */
export function reconcile(db: FounderDb, runId: string): FlowRun | null {
  const run = db.flowRuns.get(runId);
  if (run && run.status === 'running' && !active.has(runId)) {
    return db.flowRuns.update(runId, {
      status: 'interrupted',
      endedAt: new Date().toISOString(),
      currentNodeId: null,
      errorCode: 'interrupted',
      errorMessage: 'The run did not complete (the server process restarted).',
    });
  }
  return run;
}
