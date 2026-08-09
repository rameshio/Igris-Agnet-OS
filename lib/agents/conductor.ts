/**
 * Conductor routing + operator mode.
 *
 * Three ways a message is handled:
 *   1. `@<agentId|name> …` → delegate to that specialist agent's chat.
 *   2. An operator request (create / edit / delete / run an agent or the flow)
 *      → the Conductor (via the active brain, e.g. Hermes) proposes a single
 *      structured ACTION. The action is NOT executed here — it is returned for
 *      the UI to confirm, then the client calls the existing write endpoints.
 *   3. Anything else → the Conductor answers directly as the operator's brain,
 *      grounded in the current screen.
 *
 * Routing never throws on a bad `@name` — it falls back to a direct answer.
 */
import { z } from 'zod';
import { chat as llmChat } from '@/lib/connectors/llm';
import { chatWithAgent, type ChatResult } from '@/lib/agents/chat';
import type { FounderDb } from '@/lib/db';
import type { RuntimeAgent } from '@/lib/agents/runtime';

/** A proposed, not-yet-executed operator action the UI must confirm. */
export type ConductorAction =
  | { kind: 'create_agent'; name: string; instructions: string; departmentId: string }
  | { kind: 'update_agent'; agentId: string; agentName: string; name?: string; instructions?: string }
  | { kind: 'delete_agent'; agentId: string; agentName: string }
  | { kind: 'run_agent'; agentId: string; agentName: string }
  | { kind: 'run_flow' };

export type ConductorResult = ChatResult & { routedTo: string; action?: ConductorAction };

const AT_PREFIX = /^@(\S+)\s*/;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function matchAgent(agents: RuntimeAgent[], token: string): RuntimeAgent | undefined {
  const t = slug(token);
  return agents.find((a) => a.id === token || a.id === t || slug(a.name) === t);
}

// The raw action shape the brain is asked to emit (loose — we resolve refs after).
const RawActionSchema = z.object({
  action: z.enum(['create_agent', 'update_agent', 'delete_agent', 'run_agent', 'run_flow']),
  name: z.string().optional(),
  instructions: z.string().optional(),
  agent: z.string().optional(), // id-or-name reference for update/delete/run
});

/** Pull a fenced ```action / ```json block (or a bare {…"action"…}) out of the reply. */
function extractRawAction(text: string): z.infer<typeof RawActionSchema> | null {
  const fence = /```(?:action|json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fence?.[1] ?? /\{[\s\S]*?"action"[\s\S]*?\}/.exec(text)?.[0] ?? null;
  if (!candidate) return null;
  try {
    const parsed = RawActionSchema.safeParse(JSON.parse(candidate.trim()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Strip the fenced action block so the human-facing reply reads cleanly. */
function humanReply(text: string): string {
  const stripped = text.replace(/```(?:action|json)?[\s\S]*?```/gi, '').trim();
  return stripped || 'Here is the action I propose — confirm below to run it.';
}

/** Resolve a create/edit/delete/run action against the CUSTOM (mutable) roster. */
function resolveAction(
  raw: z.infer<typeof RawActionSchema>,
  customAgents: RuntimeAgent[],
  allAgents: RuntimeAgent[],
): ConductorAction | { error: string } {
  const findCustom = (ref?: string) =>
    ref ? customAgents.find((a) => a.id === ref || slug(a.name) === slug(ref)) : undefined;

  if (raw.action === 'create_agent') {
    if (!raw.name || !raw.instructions) return { error: 'A new agent needs both a name and instructions.' };
    return { kind: 'create_agent', name: raw.name, instructions: raw.instructions, departmentId: 'dept-comms' };
  }
  if (raw.action === 'update_agent') {
    const target = findCustom(raw.agent);
    if (!target) return { error: `I could not find a custom agent matching "${raw.agent ?? ''}".` };
    if (!raw.name && !raw.instructions) return { error: 'Nothing to change — give a new name or new instructions.' };
    return { kind: 'update_agent', agentId: target.id, agentName: target.name, name: raw.name, instructions: raw.instructions };
  }
  if (raw.action === 'delete_agent') {
    const target = findCustom(raw.agent);
    if (!target) return { error: `I could not find a custom agent matching "${raw.agent ?? ''}".` };
    return { kind: 'delete_agent', agentId: target.id, agentName: target.name };
  }
  if (raw.action === 'run_agent') {
    const ref = raw.agent;
    const target = allAgents.find((a) => a.id === ref || slug(a.name) === slug(ref ?? ''));
    if (!target) return { error: `I could not find an agent matching "${ref ?? ''}".` };
    return { kind: 'run_agent', agentId: target.id, agentName: target.name };
  }
  return { kind: 'run_flow' };
}

function rosterLines(agents: RuntimeAgent[]): string {
  return (
    agents
      .filter((a) => a.id !== 'conductor')
      .map((a) => `- ${a.id} — ${a.name}: ${a.description}`)
      .join('\n') || '(no agents yet)'
  );
}

/** The Conductor's general-answer prompt: operator brain, screen-aware. */
function conductorSystem(agents: RuntimeAgent[], screenContext?: string): string {
  const lines = [
    'You are the Conductor, the operator brain for IGRIS Agent (a personal AI command center).',
    'Answer the operator directly, concisely, and helpfully about anything they can see in the app.',
    'Agents available to reason about:',
    rosterLines(agents),
  ];
  if (screenContext) {
    lines.push(`\nThe operator is currently looking at this screen — use it as grounding:\n${screenContext.slice(0, 4000)}`);
  }
  return lines.join('\n');
}

/** Strict, single-purpose prompt: emit ONLY the action JSON — no prose. */
function actionSystem(agents: RuntimeAgent[]): string {
  return [
    'You are the Conductor for IGRIS Agent. The operator wants to perform ONE operation.',
    'Output ONLY a single JSON object, no prose, no code fence, no explanation. Shape:',
    '{"action":"create_agent","name":"...","instructions":"..."}',
    'Valid actions and their fields:',
    '- create_agent: name, instructions (a full system prompt describing the new agent)',
    '- update_agent: agent (existing name or id), plus any of name / instructions to change',
    '- delete_agent: agent (existing name or id)',
    '- run_agent: agent (existing name or id)',
    '- run_flow: (no other fields)',
    'Never invent an agent id — only reference agents from this roster. Only custom-* agents may be edited or deleted:',
    rosterLines(agents),
    'Respond with the JSON object and nothing else.',
  ].join('\n');
}

// Heuristic: does the message ask to create / edit / delete / run an agent or flow?
const ACTION_INTENT =
  /\b(create|make|build|add|new|set\s?up|rename|edit|update|change|modif\w+|delete|remove|drop|run|execute|start|launch)\b[\s\S]*\b(agent|flow|pipeline)\b/i;
const looksLikeAction = (msg: string): boolean => ACTION_INTENT.test(msg);

export async function routeConductorMessage(
  db: FounderDb,
  agents: RuntimeAgent[],
  message: string,
  opts: { screenContext?: string } = {},
): Promise<ConductorResult> {
  const routable = agents.filter((a) => a.id !== 'conductor');

  // 1. Explicit @mention → delegate straight to that specialist.
  const at = message.match(AT_PREFIX);
  if (at) {
    const explicit = matchAgent(routable, at[1]);
    if (explicit) {
      const delivered = message.replace(AT_PREFIX, '').trim() || message;
      const result = await chatWithAgent(db, agents, explicit.id, delivered, opts);
      return { routedTo: explicit.id, ...result };
    }
    // unknown @name → fall through to the Conductor answering directly
  }

  const custom = routable.filter((a) => a.id.startsWith('custom-'));

  // 2. Operator action intent → ONE focused, JSON-only brain call (fast + reliable).
  if (looksLikeAction(message)) {
    const res = await llmChat({ system: actionSystem(routable), messages: [{ role: 'user', content: message }] });
    const raw = extractRawAction(res.text);
    if (raw) {
      const resolved = resolveAction(raw, custom, routable);
      if ('error' in resolved) return { routedTo: 'conductor', reply: `⚠ ${resolved.error}`, messages: [] };
      const verb = resolved.kind.replace('_', ' ');
      return { routedTo: 'conductor', reply: `Proposed: ${verb}. Confirm below to run it.`, messages: [], action: resolved };
    }
    // brain didn't return parseable JSON — surface its text rather than a 2nd call
    return {
      routedTo: 'conductor',
      reply: res.text.trim() || "I couldn't turn that into an action — try \"create an agent that …\" or \"run the flow\".",
      messages: [],
    };
  }

  // 3. Otherwise the Conductor answers directly (single call), parsing an action opportunistically.
  const res = await llmChat({ system: conductorSystem(routable, opts.screenContext), messages: [{ role: 'user', content: message }] });
  const raw = extractRawAction(res.text);
  if (raw) {
    const resolved = resolveAction(raw, custom, routable);
    if (!('error' in resolved)) return { routedTo: 'conductor', reply: humanReply(res.text), messages: [], action: resolved };
  }
  return { routedTo: 'conductor', reply: res.text.trim(), messages: [] };
}
