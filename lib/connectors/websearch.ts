/**
 * Web Search connector — the REAL, tool-backed mechanism behind the `research.web`
 * capability (Architecture V2 · tool-backed eligibility, made usable).
 *
 * Provider: Tavily (https://tavily.com) — a search API built for LLM agents. This is
 * SEARCH-ONLY: it returns a bounded list of public results (title/url/snippet) so the
 * agent can retrieve *current* public-web information and cite its sources. It does NOT
 * fetch arbitrary URLs, so there is no SSRF surface here (a future `fetchWebPage` would
 * need the full SSRF blocklist before it could ship).
 *
 * Honest by construction, like every other connector: no key ⇒ it fails with setup
 * guidance and makes NO network call; a provider error surfaces the real status instead
 * of silently falling back to unsourced model knowledge. The key is resolved from the
 * passed env only (never inferred, never copied into the repo).
 */
import type { ConnectorStatus } from '@/lib/connectors/types';

/** One public-web result. Safe, model-facing shape — no raw HTML, headers, or cookies. */
export type WebSearchResult = { title: string; url: string; snippet: string; source?: string };
export type WebSearchResponse = { provider: 'tavily'; query: string; results: WebSearchResult[] };

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESULTS_CEILING = 10;
const DEFAULT_MAX_RESULTS = 5;
const MAX_QUERY_LEN = 400;

type Env = Record<string, string | undefined>;

/** The Tavily API key from the given env (process.env + .env.local overlay), or undefined. */
function resolveKey(env: Env): string | undefined {
  const raw = env.TAVILY_API_KEY;
  return raw && raw.trim() ? raw.trim() : undefined;
}

/** Clamp an arbitrary maxResults to the safe, bounded range. */
export function clampMaxResults(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_RESULTS;
  return Math.min(MAX_RESULTS_CEILING, Math.max(1, v));
}

/** A readable source label (hostname) for a result url, best-effort. */
function sourceLabel(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Search the public web for current information. Returns a bounded, source-carrying
 * result list. Throws an honest Error when the provider is not configured, the input is
 * malformed, or the provider fails — never fabricated results.
 */
export async function searchWeb(query: string, opts: { maxResults?: number } = {}, env: Env = process.env): Promise<WebSearchResponse> {
  const q = (query ?? '').trim();
  if (!q) throw new Error('web search query is required');
  const key = resolveKey(env);
  if (!key) throw new Error('Web search is not connected — set TAVILY_API_KEY under Connections to enable research.web.');

  const maxResults = clampMaxResults(opts.maxResults);
  let res: Response;
  try {
    res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query: q.slice(0, MAX_QUERY_LEN), max_results: maxResults, search_depth: 'basic' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    // Timeout / network failure — fail honestly (the task must not pretend to have searched).
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Web search request failed — ${msg}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Web search provider error ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }
  const json = (await res.json().catch(() => null)) as { results?: { title?: string; url?: string; content?: string }[] } | null;
  const results: WebSearchResult[] = (json?.results ?? [])
    .filter((r) => typeof r?.url === 'string' && r.url)
    .slice(0, maxResults)
    .map((r) => ({
      title: (r.title ?? '').toString().slice(0, 300) || (r.url as string),
      url: r.url as string,
      snippet: (r.content ?? '').toString().slice(0, 600),
      source: sourceLabel(r.url as string),
    }));
  return { provider: 'tavily', query: q, results };
}

/**
 * Honest connector status. A saved key is 'unverified' (a credential is present but no
 * live check is wired — we never claim a connection we haven't proven, and never spend a
 * search call just to paint the board). No key ⇒ 'not_configured'. Never a fake connected.
 */
export async function websearchStatus(env: Env = process.env): Promise<ConnectorStatus> {
  const base = { id: 'websearch', name: 'Web Search', kind: 'web' } as const;
  const key = resolveKey(env);
  if (!key) {
    return { ...base, state: 'not_configured', detail: 'Set TAVILY_API_KEY in .env.local to enable live web search (research.web).' };
  }
  return { ...base, state: 'unverified', detail: 'Tavily key saved — search runs live on the next research.web task (no live probe wired).' };
}
