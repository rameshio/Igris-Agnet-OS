/**
 * Web Search connector (Tavily) — the REAL tool behind `research.web`.
 *
 * Honest by construction: no key ⇒ setup guidance + NO network call; malformed input
 * rejected; results bounded; provider/timeout errors surfaced (never fabricated results).
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { searchWeb, websearchStatus, clampMaxResults } from '@/lib/connectors/websearch';

const okJson = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 500, statusText: ok ? 'OK' : 'Server Error', json: async () => body, text: async () => JSON.stringify(body) }) as Response;

afterEach(() => vi.restoreAllMocks());

describe('websearchStatus', () => {
  test('not_configured without a key — and never a fake connected', async () => {
    const s = await websearchStatus({});
    expect(s.id).toBe('websearch');
    expect(s.kind).toBe('web');
    expect(s.state).toBe('not_configured');
    expect(s.detail).toMatch(/TAVILY_API_KEY/);
  });

  test('a saved key is unverified (never claims a connection it has not proven)', async () => {
    const s = await websearchStatus({ TAVILY_API_KEY: 'tvly-x' });
    expect(s.state).toBe('unverified');
  });
});

describe('searchWeb', () => {
  test('fails honestly without a key — and makes NO network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(searchWeb('latest AI news', {}, {})).rejects.toThrow(/TAVILY_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('rejects an empty query (malformed input) with no network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(searchWeb('   ', {}, { TAVILY_API_KEY: 'tvly-x' })).rejects.toThrow(/query is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('maps provider results to safe {title,url,snippet,source} and bounds the count', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `R${i}`, url: `https://www.example.com/${i}`, content: `snippet ${i}` }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ results: many }));
    const out = await searchWeb('daily AI updates', { maxResults: 3 }, { TAVILY_API_KEY: 'tvly-x' });
    expect(out.provider).toBe('tavily');
    expect(out.results).toHaveLength(3); // bounded to maxResults
    expect(out.results[0]).toMatchObject({ title: 'R0', url: 'https://www.example.com/0', snippet: 'snippet 0', source: 'example.com' });
  });

  test('clamps maxResults into [1,10]', () => {
    expect(clampMaxResults(999)).toBe(10);
    expect(clampMaxResults(0)).toBe(1);
    expect(clampMaxResults(undefined)).toBe(5);
  });

  test('sends the key + bounded params to Tavily', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ results: [] }));
    await searchWeb('x', { maxResults: 50 }, { TAVILY_API_KEY: 'tvly-secret' });
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.api_key).toBe('tvly-secret');
    expect(body.max_results).toBe(10); // clamped
  });

  test('surfaces a provider error instead of fabricating results', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ error: 'rate limited' }, false));
    await expect(searchWeb('x', {}, { TAVILY_API_KEY: 'tvly-x' })).rejects.toThrow(/Web search provider error 500/);
  });

  test('maps a timeout/network failure to an honest error (no silent fallback)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('The operation was aborted'));
    await expect(searchWeb('x', {}, { TAVILY_API_KEY: 'tvly-x' })).rejects.toThrow(/Web search request failed/);
  });
});
