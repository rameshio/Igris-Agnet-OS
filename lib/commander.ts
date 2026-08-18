/**
 * IGRIS Commander logic (UX Foundation U2) — pure, framework-free so it is fully
 * unit-testable. The Commander UI (components/Commander.tsx) is a thin shell over
 * this. It UNIFIES the two existing systems, it is not a third brain:
 *   • GO  → deterministic search/navigation via the existing palette (filterCommands).
 *   • ASK → the existing Conductor chat backend (grounded with U1 context ids).
 *   • DO  → RECOGNITION ONLY in U2. Never executes. U3 owns Preview→Execute.
 *
 * Safety: this module performs no I/O and no mutation. The context it produces
 * for ASK contains identifiers only (from the U1 envelope) — never secrets,
 * tokens, graphs, prompts, or payloads.
 */
import type { IgrisContextEnvelope, IgrisSurface } from '@/lib/context-envelope';
import { filterCommands, type Command } from '@/lib/palette';
import type { NavItem } from '@/lib/nav';

export type CommanderLane = 'go' | 'ask' | 'do';

export type CommanderIntent = {
  lane: CommanderLane;
  /** Normalized text for the lane (GO: search terms; ASK/DO: the phrase). */
  query: string;
  /** True when the user forced the lane via a correction ("Ask instead"). */
  forced: boolean;
  /** GO via a slash command resolves straight to a route. */
  slashHref?: string;
};

/** Deterministic slash → route map. ONLY real, existing pages (no execution verbs). */
export const SLASH_ROUTES: Record<string, string> = {
  flows: '/flows',
  agents: '/agents',
  approvals: '/approvals',
  models: '/models',
  brain: '/brain',
  settings: '/settings',
  skills: '/skills',
  tasks: '/tasks',
};

/** Action verbs → DO lane (recognized, never executed in U2). */
const DO_VERBS = new Set([
  'run', 'delete', 'remove', 'archive', 'publish', 'approve', 'reject', 'send', 'switch', 'change',
  'create', 'rename', 'stop', 'cancel', 'disable', 'enable', 'deploy', 'execute', 'trigger',
]);

/** Words that clearly signal a question → ASK lane. */
const ASK_LEADS = new Set(['why', 'what', "what's", 'whats', 'how', 'when', 'where', 'which', 'who', 'explain', 'describe']);

/** Navigation lead-ins stripped from a GO query. */
const GO_LEADS = ['navigate to', 'jump to', 'go to', 'goto', 'open up', 'open', 'show me', 'show', 'view'];

function stripGoLead(input: string): string {
  const lower = input.toLowerCase();
  for (const lead of GO_LEADS) {
    if (lower === lead) return '';
    if (lower.startsWith(`${lead} `)) return input.slice(lead.length + 1).trim();
  }
  return input;
}

/**
 * Classify raw input into a lane. Deterministic; the user can override with a
 * forced lane (the "Ask instead / Go instead" corrections). Priority:
 * slash → DO verb → question → GO.
 */
export function classifyInput(raw: string, forced?: CommanderLane): CommanderIntent {
  const input = raw.trim();
  if (forced) {
    const query = forced === 'go' ? stripGoLead(input) : input.replace(/^ask\s+/i, '');
    return { lane: forced, query, forced: true };
  }
  if (input === '') return { lane: 'go', query: '', forced: false };

  if (input.startsWith('/')) {
    const body = input.slice(1);
    const head = body.split(/\s+/)[0].toLowerCase();
    if (head === 'ask') return { lane: 'ask', query: body.slice(3).trim(), forced: false };
    if (SLASH_ROUTES[head]) return { lane: 'go', query: head, slashHref: SLASH_ROUTES[head], forced: false };
    return { lane: 'go', query: body, forced: false }; // unknown slash → treat as search
  }

  const lower = input.toLowerCase();
  const w0 = lower.split(/\s+/)[0];

  if (DO_VERBS.has(w0)) return { lane: 'do', query: input, forced: false };
  if (input.endsWith('?')) return { lane: 'ask', query: input, forced: false };
  if (/\bwhy\b/.test(lower)) return { lane: 'ask', query: input, forced: false };
  if (ASK_LEADS.has(w0)) return { lane: 'ask', query: input, forced: false };

  return { lane: 'go', query: stripGoLead(input), forced: false };
}

/** Turn canonical sidebar nav items into GO commands (so GO can reach every page). */
export function navToCommands(items: NavItem[]): Command[] {
  return items.map((n) => ({
    id: `nav:${n.href}`,
    label: n.label,
    keywords: `${n.label} ${n.href.replace(/\//g, ' ')}`.toLowerCase(),
    href: n.href,
    hint: 'view',
  }));
}

/** Merge command lists, de-duplicating by href (primary wins). */
export function mergeCommands(primary: Command[], extra: Command[]): Command[] {
  const seen = new Set(primary.map((c) => c.href));
  return [...primary, ...extra.filter((c) => !seen.has(c.href))];
}

/** GO results for an intent (empty for slash-nav, which navigates directly). */
export function goHits(commands: Command[], intent: CommanderIntent, limit = 8): Command[] {
  if (intent.slashHref) return [];
  return filterCommands(commands, intent.query).slice(0, limit);
}

const SURFACE_LABEL: Record<IgrisSurface, string> = {
  home: 'Home', flows: 'Flows', agents: 'Agents', approvals: 'Approvals',
  brain: 'G-Brain', models: 'Models', settings: 'Settings', other: 'IGRIS',
};

/** Human-readable breadcrumb of the current context, e.g. "Flows › wf-main › node n1". */
export function describeContext(env: IgrisContextEnvelope): string {
  const parts: string[] = [SURFACE_LABEL[env.surface]];
  if (env.workflowId) parts.push(env.workflowId);
  if (env.selectedNodeId) parts.push(`node ${env.selectedNodeId}`);
  else if (env.selectedEdgeId) parts.push(`edge ${env.selectedEdgeId}`);
  if (env.runId) parts.push(`run ${env.runId}`);
  if (env.agentId) parts.push(`agent ${env.agentId}`);
  if (env.approvalId) parts.push(`approval ${env.approvalId}`);
  return parts.join(' › ');
}

/**
 * Compact context block sent to the Conductor for an ASK. IDENTIFIERS ONLY (the
 * envelope carries nothing else) — the backend can resolve safe detail from these
 * ids via its own repository lookups. Never contains secrets/graphs/payloads.
 */
export function buildAskContext(env: IgrisContextEnvelope): string {
  const lines = [`route: ${env.route}`, `surface: ${env.surface}`];
  const add = (k: string, v: unknown) => {
    if (v !== undefined && v !== null) lines.push(`${k}: ${v}`);
  };
  add('workflowId', env.workflowId);
  add('workflowVersion', env.workflowVersion);
  add('workflowDraft', env.workflowDraft);
  add('selectedNodeId', env.selectedNodeId);
  add('selectedEdgeId', env.selectedEdgeId);
  add('runId', env.runId);
  add('agentId', env.agentId);
  add('approvalId', env.approvalId);
  return `IGRIS context (identifiers only):\n${lines.join('\n')}`;
}

/** "this workflow/node/run/…" phrases mapped to the envelope key that resolves them. */
const CONTEXT_REFS: [phrase: string, key: keyof IgrisContextEnvelope][] = [
  ['this workflow', 'workflowId'],
  ['this node', 'selectedNodeId'],
  ['this edge', 'selectedEdgeId'],
  ['this run', 'runId'],
  ['this agent', 'agentId'],
  ['this approval', 'approvalId'],
];

/**
 * Phrases in the question that reference context the envelope does NOT currently
 * have. When non-empty, the Commander should answer honestly ("nothing selected")
 * instead of guessing.
 */
export function unresolvedReferences(env: IgrisContextEnvelope, text: string): string[] {
  const lower = text.toLowerCase();
  return CONTEXT_REFS.filter(([phrase, key]) => lower.includes(phrase) && env[key] === undefined).map(([phrase]) => phrase);
}

export type ProposedAction = {
  verb: string;
  summary: string;
  /** Always true in U2 — nothing executes until U3 adds Preview→Execute. */
  requiresPreview: true;
};

/** Recognize a DO request as a proposed action. RECOGNITION ONLY — never executes. */
export function recognizeDoAction(input: string): ProposedAction {
  const verb = input.trim().toLowerCase().split(/\s+/)[0] || 'do';
  const pretty = verb.charAt(0).toUpperCase() + verb.slice(1);
  return { verb, summary: `${pretty} — “${input.trim()}”`, requiresPreview: true };
}

/** True when a keyboard event is the Commander toggle (Ctrl/Cmd+K). Pure — testable. */
export function isCommanderToggle(e: { key: string; metaKey?: boolean; ctrlKey?: boolean }): boolean {
  return (e.metaKey === true || e.ctrlKey === true) && e.key.toLowerCase() === 'k';
}
