/**
 * POST /api/agents/email-digest — run the Gmail → Telegram digest.
 * body { chatId: string, limit?: number }
 * Reads recent email, summarizes with the active brain, sends to Telegram.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runEmailDigest } from '@/lib/agents/email-digest';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({
  chatId: z.string().min(1),
  limit: z.number().int().min(1).max(25).optional(),
});

export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, step: 'send', detail: 'chatId is required' }, { status: 400 });
  }
  const result = await runEmailDigest({ chatId: body.chatId, limit: body.limit });
  return NextResponse.json(result, { status: result.ok ? 200 : 200 });
}
