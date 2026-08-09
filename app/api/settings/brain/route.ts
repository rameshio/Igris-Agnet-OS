/**
 * Brain settings — choose what powers agent thinking.
 *   GET  → the active provider + the saved Hermes CLI path
 *   POST → { provider: 'gateway' | 'hermes', hermesBin? } → saved to .env.local
 * Writing LLM_PROVIDER/HERMES_CLI_BIN takes effect immediately (read fresh).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readEnvLocal, upsertEnvLocal } from '@/lib/creds';
import { activeLlmProviderName } from '@/lib/connectors/llm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  const env = readEnvLocal();
  return NextResponse.json({
    provider: activeLlmProviderName(),
    hermesBin: env.HERMES_CLI_BIN ?? 'hermes',
  });
}

const Body = z.object({
  provider: z.enum(['gateway', 'hermes']),
  hermesBin: z.string().max(400).optional(),
});

export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "provider must be 'gateway' or 'hermes'" }, { status: 400 });
  }
  const patch: Record<string, string> = { LLM_PROVIDER: body.provider };
  if (body.provider === 'hermes' && body.hermesBin?.trim()) patch.HERMES_CLI_BIN = body.hermesBin.trim();
  upsertEnvLocal(patch);
  return NextResponse.json({ ok: true, provider: body.provider });
}
