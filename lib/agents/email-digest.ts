/**
 * Gmail → Telegram digest — a concrete, reliable agent pipeline (not left to the
 * model to orchestrate): (1) read recent email via the Gmail/IMAP connector,
 * (2) have the active brain summarize it (works with the cloud gateway OR the
 * local Hermes CLI — it's just text in, text out), (3) send the digest to a
 * Telegram chat. Each step fails honestly and says which step failed and why.
 *
 * Deps are injectable so the pipeline is unit-testable without a real inbox,
 * model, or bot.
 */
import { latestEmails } from '@/lib/connectors/email';
import { sendTelegramMessage } from '@/lib/connectors/telegram';
import { chat as llmChat } from '@/lib/connectors/llm';
import { runtimeEnv } from '@/lib/creds';
import type { CommsItem } from '@/lib/comms';

export type DigestStep = 'read' | 'summarize' | 'send' | 'done';
export type DigestResult = {
  ok: boolean;
  step: DigestStep;
  detail: string;
  emailsRead?: number;
  summary?: string;
};

export type DigestDeps = {
  readEmail: (limit: number, env: Record<string, string | undefined>) => Promise<CommsItem[]>;
  summarize: (system: string, user: string) => Promise<string>;
  send: (chatId: string, text: string, env: Record<string, string | undefined>) => Promise<{ ok: boolean; detail: string }>;
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const DEFAULT_DEPS: DigestDeps = {
  readEmail: (limit, env) => latestEmails(limit, env),
  summarize: async (system, user) => (await llmChat({ system, messages: [{ role: 'user', content: user }] })).text.trim(),
  send: (chatId, text, env) => sendTelegramMessage(chatId, text, env),
};

const SUMMARY_SYSTEM = [
  'You summarize an inbox for a busy operator.',
  'Given a list of recent emails (sender + subject), write a short, skimmable digest.',
  'Group or bullet by what matters; flag anything that looks urgent or needs a reply.',
  'Be concise. No preamble, no sign-off — just the digest.',
].join('\n');

export async function runEmailDigest(
  opts: { chatId: string; limit?: number },
  deps: DigestDeps = DEFAULT_DEPS,
): Promise<DigestResult> {
  const env = runtimeEnv();
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const chatId = opts.chatId.trim();
  if (!chatId) return { ok: false, step: 'send', detail: 'A Telegram chat id is required to send the digest.' };

  // 1) read
  let emails: CommsItem[];
  try {
    emails = await deps.readEmail(limit, env);
  } catch (e) {
    return { ok: false, step: 'read', detail: `Couldn't read email: ${errMsg(e)}. Connect Gmail under Connections (INBOX_1_* app password).` };
  }
  if (emails.length === 0) {
    return { ok: false, step: 'read', detail: 'No recent emails found. Is Gmail connected and is IMAP enabled?' };
  }

  // 2) summarize (through whatever brain is active — gateway or Hermes)
  const list = emails.map((m, i) => `${i + 1}. From ${m.sender} — ${m.preview}`).join('\n');
  let summary: string;
  try {
    summary = await deps.summarize(SUMMARY_SYSTEM, `Summarize these ${emails.length} recent emails:\n\n${list}`);
  } catch (e) {
    return { ok: false, step: 'summarize', detail: `The brain failed to summarize: ${errMsg(e)}`, emailsRead: emails.length };
  }
  if (!summary) {
    return { ok: false, step: 'summarize', detail: 'The brain returned an empty summary.', emailsRead: emails.length };
  }

  // 3) send to Telegram
  const text = `📬 Inbox digest — ${emails.length} recent emails\n\n${summary}`;
  const sent = await deps.send(chatId, text, env);
  if (!sent.ok) {
    return { ok: false, step: 'send', detail: `Summarized ${emails.length} emails but the Telegram send failed: ${sent.detail}`, emailsRead: emails.length, summary };
  }

  return { ok: true, step: 'done', detail: `Read ${emails.length} emails, summarized, and sent to Telegram.`, emailsRead: emails.length, summary };
}
