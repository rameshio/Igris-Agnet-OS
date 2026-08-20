/**
 * Company Intelligence service (Architecture V2 · F6) — the single read boundary
 * that assembles a bounded, typed `CompanyIntelligenceSnapshot` from the analyzers.
 *
 * DERIVED + READ-ONLY: it composes canonical reads (missions, tasks, agents,
 * capabilities, workflow runs, approvals, events, proposals) into counts, timings,
 * coverage, and DETERMINISTIC signals. It never mutates canonical state, never
 * creates agents, never automates remediation, and adds no new event/telemetry
 * store. React calls ONE API; it never queries each subsystem separately.
 */
import type { FounderDb } from '@/lib/db';
import {
  deriveSignals,
  parseIntelWindow,
  resolveWindow,
  type CompanyIntelligenceSnapshot,
} from '@/lib/company/intelligence/model';
import { buildWorkHealth } from '@/lib/company/intelligence/work-health';
import { buildCapabilityHealth } from '@/lib/company/intelligence/capabilities';
import { buildExecutionHealth } from '@/lib/company/intelligence/execution';
import { buildApprovalHealth } from '@/lib/company/intelligence/approvals';
import { buildAgentHealth } from '@/lib/company/intelligence/agents';

export function getCompanyIntelligence(db: FounderDb, opts: { window?: string } = {}): CompanyIntelligenceSnapshot {
  const key = parseIntelWindow(opts.window); // throws IntelError(400) on an invalid non-empty window
  const w = resolveWindow(key);

  const workHealth = buildWorkHealth(db, w);
  const capabilityHealth = buildCapabilityHealth(db, w);
  const execution = buildExecutionHealth(db, w);
  const approvals = buildApprovalHealth(db, w);
  const agentHealth = buildAgentHealth(db, w);

  const signals = deriveSignals({
    staleTasks: workHealth.staleTasks,
    missions: workHealth.missions,
    capabilities: capabilityHealth.capabilities,
    delayedApprovals: approvals.delayedApprovals,
    repeatedFailures: execution.repeatedFailures,
    agents: agentHealth,
    workflowClusters: execution.workflowClusters,
  });

  return {
    generatedAt: w.toIso,
    window: { from: w.fromIso, to: w.toIso, key: w.key },
    workHealth,
    capabilityHealth,
    executionHealth: execution.insight,
    approvalHealth: approvals.insight,
    agentHealth,
    signals,
  };
}
