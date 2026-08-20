/**
 * Capability Intelligence analyzer (Architecture V2 · F6). Uses the F0.1 resolver
 * over canonical capability assignments to classify coverage (healthy /
 * single-point / gap), correlates in-window CAPABILITY_GAP events and factory
 * promotions, and counts how much active work depends on each capability.
 *
 * READ-ONLY: never mutates assignments, never auto-creates an agent (the Factory
 * F2 stays the sole creation authority). Exact capability-id matching only
 * (inherits F0.1 — no semantic inference).
 */
import type { FounderDb } from '@/lib/db';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { resolveAgents } from '@/lib/agents/capabilities';
import { isTaskTerminal, type CompanyTask } from '@/lib/company/model';
import {
  classifyCoverage,
  type CapabilityCoverage,
  type CapabilityInsight,
  type WindowBounds,
} from '@/lib/company/intelligence/model';

const MAX_WINDOW_EVENTS = 500;

export function buildCapabilityHealth(db: FounderDb, w: WindowBounds): CapabilityInsight {
  const tasks = db.companyTasks.all();
  const activeTasks = tasks.filter((t) => !isTaskTerminal(t.status));
  const taskById = new Map<string, CompanyTask>(tasks.map((t) => [t.id, t]));

  const agents = allRuntimeAgents(db).map((a) => ({ id: a.id, name: a.name }));
  const assignments = db.agentCapabilities.all();

  // How many ACTIVE tasks currently require each capability.
  const requiredByTasks = new Map<string, number>();
  for (const t of activeTasks) {
    for (const cap of new Set(t.requiredCapabilities)) requiredByTasks.set(cap, (requiredByTasks.get(cap) ?? 0) + 1);
  }

  // In-window CAPABILITY_GAP events, correlated to the capabilities their task required.
  const gapEvents = db.companyEvents.since(w.fromIso, MAX_WINDOW_EVENTS).filter((e) => e.type === 'CAPABILITY_GAP');
  const gapEventsPerCap = new Map<string, number>();
  for (const e of gapEvents) {
    const task = e.taskId ? taskById.get(e.taskId) : undefined;
    for (const cap of new Set(task?.requiredCapabilities ?? [])) gapEventsPerCap.set(cap, (gapEventsPerCap.get(cap) ?? 0) + 1);
  }

  // Factory agents promoted in-window, correlated to the capabilities they were granted.
  const promotedInWindow = db.companyAgentProposals
    .all()
    .filter((p) => p.status === 'approved' && p.agentId && p.decidedAt && new Date(p.decidedAt).getTime() >= w.fromMs && new Date(p.decidedAt).getTime() <= w.toMs);
  const tempAgentsPerCap = new Map<string, number>();
  for (const p of promotedInWindow) {
    for (const cap of new Set(p.requiredCapabilities)) tempAgentsPerCap.set(cap, (tempAgentsPerCap.get(cap) ?? 0) + 1);
  }

  // The capabilities worth reporting: those active work needs + those that hit a gap in-window.
  const capIds = new Set<string>([...requiredByTasks.keys(), ...gapEventsPerCap.keys()]);

  // eligible-agent count per capability (deterministic F0.1 resolution; exact-id match).
  const eligibleFor = (cap: string): number => resolveAgents({ agents, assignments, required: [cap], mode: 'all' }).length;

  const capabilities: CapabilityCoverage[] = [...capIds]
    .map((capabilityId) => {
      const eligibleAgents = eligibleFor(capabilityId);
      return {
        capabilityId,
        requiredByTasks: requiredByTasks.get(capabilityId) ?? 0,
        eligibleAgents,
        coverageStatus: classifyCoverage(eligibleAgents),
        gapEventsInWindow: gapEventsPerCap.get(capabilityId) ?? 0,
        temporaryAgentsInWindow: tempAgentsPerCap.get(capabilityId) ?? 0,
      };
    })
    .sort((a, b) => b.requiredByTasks - a.requiredByTasks || (a.capabilityId < b.capabilityId ? -1 : 1));

  // Active tasks blocked by a genuinely uncovered capability.
  const zeroCoverage = new Set(capabilities.filter((c) => c.coverageStatus === 'gap').map((c) => c.capabilityId));
  const unresolvedGapTasks = activeTasks.filter((t) => t.requiredCapabilities.some((c) => zeroCoverage.has(c))).length;

  return {
    capabilities,
    gaps: capabilities.filter((c) => c.coverageStatus === 'gap').length,
    singlePoints: capabilities.filter((c) => c.coverageStatus === 'single_point').length,
    healthy: capabilities.filter((c) => c.coverageStatus === 'healthy').length,
    unresolvedGapTasks,
    capabilityGapEventsInWindow: gapEvents.length,
    temporaryAgentsInWindow: promotedInWindow.length,
  };
}
