/**
 * Telegram Bot connector. Auth is a single bot token from @BotFather. Status is
 * verified for real: it calls the Bot API `getMe`, so a saved token only reads
 * "connected" when Telegram confirms it — never a fake connected. `sendMessage`
 * posts a test message to a chat the bot can reach.
 */
import type { ConnectorStatus } from '@/lib/connectors/types';

const API = 'https://api.telegram.org';

type TelegramMe = { ok?: boolean; result?: { username?: string; first_name?: string }; description?: string };

export async function telegramStatus(
  env: Record<string, string | undefined> = process.env,
): Promise<ConnectorStatus> {
  const base = { id: 'telegram', name: 'Telegram', kind: 'social' } as const;
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return {
      ...base,
      state: 'not_configured',
      detail: 'Set TELEGRAM_BOT_TOKEN in .env.local. Create a bot with @BotFather to get the token.',
    };
  }
  try {
    const res = await fetch(`${API}/bot${token}/getMe`, { signal: AbortSignal.timeout(6000) });
    const body = (await res.json()) as TelegramMe;
    if (!res.ok || !body.ok || !body.result) {
      throw new Error(body.description ?? `HTTP ${res.status}`);
    }
    const handle = body.result.username ? `@${body.result.username}` : body.result.first_name ?? 'bot';
    return {
      ...base,
      state: 'connected',
      detail: `Connected as ${handle}`,
      meta: { username: String(body.result.username ?? '') },
    };
  } catch (err) {
    return {
      ...base,
      state: 'error',
      detail: `Token set but auth failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export type TelegramChat = { chatId: string; name: string };

/**
 * Recent chats the bot can see, from getUpdates — so a user who messaged the
 * bot (/start) can pick their chat id without hunting for it. Empty when no
 * token, a webhook is set, or nobody has messaged the bot yet.
 */
export async function recentTelegramChats(
  env: Record<string, string | undefined> = process.env,
): Promise<TelegramChat[]> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return [];
  try {
    const res = await fetch(`${API}/bot${token}/getUpdates?limit=30`, { signal: AbortSignal.timeout(6000) });
    const body = (await res.json()) as {
      ok?: boolean;
      result?: Array<{ message?: { chat?: { id?: number; first_name?: string; username?: string; title?: string } } }>;
    };
    if (!body.ok || !Array.isArray(body.result)) return [];
    const seen = new Map<string, string>();
    for (const u of body.result) {
      const chat = u.message?.chat;
      if (chat?.id == null) continue;
      const name = chat.title ?? (chat.username ? `@${chat.username}` : chat.first_name) ?? String(chat.id);
      seen.set(String(chat.id), name);
    }
    return [...seen.entries()].map(([chatId, name]) => ({ chatId, name }));
  } catch {
    return [];
  }
}

export type TelegramSendResult = { ok: boolean; detail: string };

/** Post a message to a chat id. Fails honestly without a token / on API error. */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  env: Record<string, string | undefined> = process.env,
): Promise<TelegramSendResult> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, detail: 'TELEGRAM_BOT_TOKEN not set — add it under Connections → Telegram' };
  if (!chatId.trim()) return { ok: false, detail: 'chat id is required' };
  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(6000),
    });
    const body = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !body.ok) return { ok: false, detail: body.description ?? `HTTP ${res.status}` };
    return { ok: true, detail: `sent to chat ${chatId}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
