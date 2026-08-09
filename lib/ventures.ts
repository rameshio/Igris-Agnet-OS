/**
 * The venture lens over the OS — a client's business lines.
 *
 * One database, one G-Brain, one agent roster: ventures never partition the
 * data. They are saved filters — each one names the agents that serve it per
 * life area, the brain tag that marks its pages, and the current focus.
 * Switching venture in the hierarchy or life map swaps which crew lights up;
 * the agents themselves keep full visibility of everything.
 *
 * These are neutral placeholders — a client renames them (and their focus
 * lists) to their own business lines. Internal ids stay stable so URLs,
 * the funnel schema, and saved data keep working across a rename.
 */
import type { LifeArea } from '@/lib/life-map';
import { LIFE_AREAS } from '@/lib/life-map';

export type Venture = {
  id: string;
  label: string;
  kind: string;
  color: string;
  detail: string;
  /** Tag that marks this venture's pages inside the single shared G-Brain. */
  brainTag: string;
  /** Current priorities for this business line — a client edits these freely. */
  focus: string[];
  /** life-area id → the agents working that area FOR this venture. */
  areaAgents: Record<string, string[]>;
};

const SHARED_OPS = ['conductor', 'stack-monitor'];
const SHARED_KNOWLEDGE = ['data-agent', 'markdown-auditor', 'vector-auditor'];

export const VENTURES: Venture[] = [
  {
    id: 'vantage',
    label: 'Venture One',
    kind: 'Primary business line',
    color: '#00ffaa',
    detail: 'Your primary business line — rename it and set its focus in this file.',
    brainTag: 'vantage',
    focus: [
      'Active work shipped on schedule',
      'Pipeline: proposals out, deals advanced',
      'Delivery quality — every handoff documented',
    ],
    areaAgents: {
      marketing: ['social-agent', 'zernio-publisher', 'remotion-editor', 'higgsfield-creative'],
      sales: ['vantage-sales', 'vantage-fanbasis', 'sales-agent', 'sales-calls-data'],
      communication: ['comms-agent', 'gmail-worker', 'slack-worker', 'crm-pulse'],
      finances: ['payments-pulse', 'stripe-sales', 'processor-confirmation'],
      knowledge: [...SHARED_KNOWLEDGE, 'notion-sync'],
      operations: SHARED_OPS,
    },
  },
  {
    id: 'launchpad-cohort',
    label: 'Venture Two',
    kind: 'Secondary business line',
    color: '#d9263f',
    detail: 'A second business line — rename it and set its focus in this file.',
    brainTag: 'launchpad-cohort',
    focus: [
      'Track outcomes — surface wins, unblock fast',
      'Content + newsletter cadence for growth',
      'Community pulse; keep response times tight',
    ],
    areaAgents: {
      marketing: ['social-agent', 'arcads-creative', 'zernio-publisher', 'manychat-mcp', 'remotion-editor'],
      sales: ['launchpad-cohort-sales', 'fanbasis-sales', 'sales-agent', 'sales-calls-data'],
      communication: ['whatsapp-worker', 'gmail-worker', 'comms-agent', 'crm-pulse'],
      finances: ['payments-pulse', 'stripe-sales', 'pava-financing', 'processor-confirmation'],
      knowledge: SHARED_KNOWLEDGE,
      operations: SHARED_OPS,
    },
  },
  {
    // Internal id/brainTag stay 'brand-deals'; presented as a third line.
    id: 'brand-deals',
    label: 'Venture Three',
    kind: 'Side project / partnerships',
    color: '#a3e635',
    detail: 'A third line — partnerships or a side project. Rename it in this file.',
    brainTag: 'brand-deals',
    focus: [
      'Inbound offers triaged and answered',
      'Deliverables calendar — no missed windows',
      'Invoices out and chased; rates documented',
    ],
    areaAgents: {
      marketing: ['arcads-creative', 'social-agent', 'zernio-publisher', 'higgsfield-creative', 'remotion-editor'],
      sales: ['sales-agent', 'crm-pulse'],
      communication: ['gmail-worker', 'crm-pulse', 'comms-agent'],
      finances: ['payments-pulse', 'stripe-sales'],
      knowledge: SHARED_KNOWLEDGE,
      operations: SHARED_OPS,
    },
  },
];

export function getVenture(id: string): Venture | null {
  return VENTURES.find((v) => v.id === id) ?? null;
}

/** Every agent serving a venture, across all its life areas. */
export function ventureAgentSet(ventureId: string): Set<string> {
  const v = getVenture(ventureId);
  return new Set(v ? Object.values(v.areaAgents).flat() : []);
}

/** Which ventures an agent works for (shared infra agents serve all). */
export function venturesForAgent(agentId: string): Venture[] {
  return VENTURES.filter((v) => ventureAgentSet(v.id).has(agentId));
}

/** Agents on one life area for one venture (the click-through Alex described). */
export function ventureAreaAgents(ventureId: string, areaId: string): string[] {
  return getVenture(ventureId)?.areaAgents[areaId] ?? [];
}

export function lifeAreaById(areaId: string): LifeArea | null {
  return LIFE_AREAS.find((a) => a.id === areaId) ?? null;
}
