/**
 * Generic OpenAI-compatible chat provider. Given a base URL, API key, and model
 * id, it POSTs to `${baseUrl}/chat/completions` — the shape OpenAI, Anthropic,
 * xAI, DeepSeek, Groq, Mistral, OpenRouter, Together, etc. all speak. This is
 * how an agent runs on a model the operator connected on the Models board.
 *
 * Text in / text out (no tool-calling in v1 — the agent's tools still work when
 * it runs on the local brain). Errors surface honestly instead of hanging.
 */
import type { LlmProvider } from '@/lib/connectors/llm';

export function createOpenAiCompatibleProvider(baseUrl: string, apiKey: string, model: string): LlmProvider {
  return {
    name: `openai-compatible:${model}`,
    async chat(req) {
      const messages = [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        ...req.messages.filter((m) => m.role !== 'tool').map((m) => ({ role: m.role, content: m.content })),
      ];
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          // OpenRouter asks for these; harmless elsewhere.
          'HTTP-Referer': 'https://igris.local',
          'X-Title': 'IGRIS Agent',
        },
        body: JSON.stringify({ model, messages }),
      }).catch((e) => {
        throw new Error(`Could not reach ${baseUrl} — ${e instanceof Error ? e.message : String(e)}`);
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Model API ${res.status}: ${body.slice(0, 300) || res.statusText}`);
      }
      const json = (await res.json().catch(() => null)) as
        | { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
        | null;
      const text = json?.choices?.[0]?.message?.content ?? '';
      return {
        text: text.trim(),
        toolCalls: [],
        usage: json?.usage
          ? { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 }
          : undefined,
      };
    },
  };
}

/** Fetch a provider's live model ids (OpenAI-compatible `/models`). */
export async function fetchProviderModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const json = (await res.json()) as { data?: { id?: string }[] };
  return (json.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x)).sort();
}
