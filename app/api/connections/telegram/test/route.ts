/**
 * Telegram test surface for the connections board.
 *   GET  → recent chats the bot can see (getUpdates), so the user can pick a chat id
 *   POST → send a test message { chatId, text? } to that chat
 * Reads the token from .env.local via runtimeEnv; never echoes it back.
 */
import { NextResponse } from 'next/server';
import { runtimeEnv } from '@/lib/creds';
import { recentTelegramChats, sendTelegramMessage } from '@/lib/connectors/telegram';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const chats = await recentTelegramChats(runtimeEnv());
  return NextResponse.json({ chats });
}

export async function POST(req: Request) {
  let body: { chatId?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, detail: 'invalid JSON body' }, { status: 400 });
  }
  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
  const text =
    typeof body.text === 'string' && body.text.trim()
      ? body.text.slice(0, 2000)
      : '✅ IGRIS connected — this is a test message.';
  if (!chatId) return NextResponse.json({ ok: false, detail: 'chat id is required' }, { status: 400 });

  const result = await sendTelegramMessage(chatId, text, runtimeEnv());
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
