/**
 * Agent tool registry — turns an integration slug a custom agent has connected
 * into real, callable LlmToolSpecs backed by a live connector. This is what
 * makes a custom agent *agentic*: during a run/chat the model can call these to
 * read live data or take an action, then reason over the result.
 *
 * `gbrain` is special: it's the SHARED MEMORY that connects agents together.
 * Any agent with G-Brain connected can search what other agents saved and save
 * its own findings for them — a blackboard the whole roster reads and writes.
 *
 * Only slugs listed here have real capabilities; an agent may carry other slugs
 * (recorded on the agent) but they stay inert until wired here. Every execute
 * fails honestly (returns { error }) when the connector isn't configured.
 */
import { z } from 'zod';
import type { LlmToolSpec } from '@/lib/connectors/llm';
import { runtimeEnv } from '@/lib/creds';
import { recentMessages } from '@/lib/connectors/slack';
import { unreadCounts } from '@/lib/connectors/email';
import { recentPages } from '@/lib/connectors/notion';
import { sendTelegramMessage } from '@/lib/connectors/telegram';
import { stripeSnapshot } from '@/lib/connectors/payments';
import { attioClients } from '@/lib/connectors/attio';
import { searchWeb } from '@/lib/connectors/websearch';
import { getBrainProvider } from '@/lib/brain';
import { writeBrainDump } from '@/lib/brain-dump';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// slug -> the tools that slug provides (usually one; G-Brain provides two).
const REGISTRY: Record<string, () => LlmToolSpec[]> = {
  slack: () => [
    {
      name: 'readSlackMessages',
      description: 'Read the most recent messages from Slack channels the bot belongs to. Read-only.',
      parameters: z.object({ limit: z.number().int().min(1).max(50).optional().describe('max messages, default 10') }),
      execute: async (args) => {
        const limit = typeof args.limit === 'number' ? args.limit : 10;
        try {
          return { messages: await recentMessages(limit, runtimeEnv()) };
        } catch (e) {
          return { error: errMsg(e) };
        }
      },
    },
  ],
  gmail: () => [
    {
      name: 'readUnreadEmail',
      description: 'Read the unread email count for each configured inbox. Read-only.',
      parameters: z.object({}),
      execute: async () => {
        try {
          return { inboxes: await unreadCounts(runtimeEnv()) };
        } catch (e) {
          return { error: errMsg(e) };
        }
      },
    },
  ],
  notion: () => [
    {
      name: 'readNotionPages',
      description: 'List the most recently edited Notion pages shared with the integration. Read-only.',
      parameters: z.object({ limit: z.number().int().min(1).max(50).optional() }),
      execute: async (args) => {
        const env = runtimeEnv();
        if (!env.NOTION_API_KEY) return { error: 'Notion is not connected (set NOTION_API_KEY under Connections).' };
        try {
          return { pages: await recentPages(typeof args.limit === 'number' ? args.limit : 10, env) };
        } catch (e) {
          return { error: errMsg(e) };
        }
      },
    },
  ],
  telegram: () => [
    {
      name: 'sendTelegramMessage',
      description: 'Send a Telegram message to a chat id through the connected bot.',
      parameters: z.object({ chatId: z.string().describe('the target chat id'), text: z.string().describe('message text') }),
      execute: async (args) => {
        const chatId = typeof args.chatId === 'string' ? args.chatId : '';
        const text = typeof args.text === 'string' ? args.text : '';
        return sendTelegramMessage(chatId, text, runtimeEnv());
      },
    },
  ],
  stripe: () => [
    {
      name: 'readStripeSnapshot',
      description: 'Read the Stripe available balance and recent charges. Read-only.',
      parameters: z.object({}),
      execute: async () => {
        const env = runtimeEnv();
        if (!env.STRIPE_SECRET_KEY) return { error: 'Stripe is not connected (set STRIPE_SECRET_KEY under Connections).' };
        try {
          return await stripeSnapshot(env);
        } catch (e) {
          return { error: errMsg(e) };
        }
      },
    },
  ],
  attio: () => [
    {
      name: 'readAttioClients',
      description: 'Read the client / deal list from the Attio CRM. Read-only.',
      parameters: z.object({}),
      execute: async () => {
        try {
          return await attioClients();
        } catch (e) {
          return { error: errMsg(e) };
        }
      },
    },
  ],
  // Live public web search (Tavily). This is the REAL tool behind `research.web`:
  // an agent with it can retrieve *current* public information and cite sources.
  // Search-only (no arbitrary URL fetch) → no SSRF surface. Fails honestly when the
  // provider is unconfigured or errors — never fabricated results.
  'web.search': () => [
    {
      name: 'searchWeb',
      description:
        'Search the public web for current information. Returns a bounded list of results (title, url, snippet, source). Read-only. Cite the urls you use.',
      parameters: z.object({
        query: z.string().describe('the search query'),
        maxResults: z.number().int().min(1).max(10).optional().describe('max results, default 5'),
      }),
      execute: async (args) => {
        const query = typeof args.query === 'string' ? args.query : '';
        if (!query.trim()) return { error: 'query is required' };
        const maxResults = typeof args.maxResults === 'number' ? args.maxResults : undefined;
        try {
          return await searchWeb(query, { maxResults }, runtimeEnv());
        } catch (e) {
          return { error: errMsg(e) };
        }
      },
    },
  ],
  // Shared memory: connect this to link an agent into the common G-Brain that
  // every other agent reads and writes. This is how agents connect together.
  gbrain: () => [
    {
      name: 'searchGBrain',
      description:
        'Search the shared G-Brain knowledge base — notes you and OTHER agents have saved. Use it to build on what the team already knows. Read-only.',
      parameters: z.object({ query: z.string().describe('what to look up in shared memory') }),
      execute: async (args) => {
        const query = typeof args.query === 'string' ? args.query : '';
        try {
          return { results: (await getBrainProvider().search(query)).slice(0, 5) };
        } catch (e) {
          return { error: errMsg(e) };
        }
      },
    },
    {
      name: 'saveToGBrain',
      description:
        'Save a note to the shared G-Brain so other agents (and you, later) can find it. Use for findings, decisions, and summaries worth remembering.',
      parameters: z.object({ title: z.string().describe('short title'), note: z.string().describe('the content to remember') }),
      execute: async (args) => {
        const title = typeof args.title === 'string' ? args.title : '';
        const note = typeof args.note === 'string' ? args.note : '';
        if (!note.trim()) return { error: 'note is required' };
        try {
          const r = writeBrainDump({ text: note, title: title || undefined, folder: 'inbox', tags: ['agent'] });
          return { saved: r.relPath, title: r.title };
        } catch (e) {
          return { error: errMsg(e) };
        }
      },
    },
  ],
};

/** The tool specs for the slugs an agent has connected that are actually wired. */
export function agentToolSpecsFor(slugs: string[]): LlmToolSpec[] {
  return slugs.filter((s) => REGISTRY[s]).flatMap((s) => REGISTRY[s]());
}

/** Integration slugs that currently resolve to real agent capabilities. */
export const WIRED_TOOL_SLUGS: string[] = Object.keys(REGISTRY);
