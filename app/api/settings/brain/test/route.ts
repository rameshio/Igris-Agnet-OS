/**
 * POST /api/settings/brain/test — prove the active brain actually answers.
 * Sends a tiny prompt through whatever provider is selected (gateway or the
 * local Hermes CLI) and returns the text, or an honest error.
 */
import { NextResponse } from 'next/server';
import { getLlmProvider, activeLlmProviderName } from '@/lib/connectors/llm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const provider = activeLlmProviderName();
  try {
    const res = await getLlmProvider().chat({
      system: 'You are a connectivity check. Answer in one short line.',
      messages: [{ role: 'user', content: 'Reply with exactly: BRAIN OK' }],
    });
    return NextResponse.json({ ok: true, provider, text: res.text.slice(0, 500) });
  } catch (err) {
    return NextResponse.json(
      { ok: false, provider, error: err instanceof Error ? err.message : String(err) },
      { status: 200 },
    );
  }
}
