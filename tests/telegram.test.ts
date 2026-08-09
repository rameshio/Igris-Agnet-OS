import { afterEach, describe, expect, test, vi } from 'vitest';
import { telegramStatus, sendTelegramMessage } from '@/lib/connectors/telegram';

const okJson = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 401, json: async () => body }) as Response;

afterEach(() => vi.restoreAllMocks());

describe('telegramStatus', () => {
  test('not_configured without a token — and makes no network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const status = await telegramStatus({});
    expect(status.id).toBe('telegram');
    expect(status.state).toBe('not_configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('connected when getMe confirms the token — reports the bot handle', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({ ok: true, result: { username: 'igris_bot', first_name: 'IGRIS' } }),
    );
    const status = await telegramStatus({ TELEGRAM_BOT_TOKEN: '123:abc' });
    expect(status.state).toBe('connected');
    expect(status.detail).toContain('@igris_bot');
  });

  test('error — never a fake connected — when getMe rejects the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({ ok: false, description: 'Unauthorized' }, false),
    );
    const status = await telegramStatus({ TELEGRAM_BOT_TOKEN: 'bad-token' });
    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/Unauthorized/);
  });
});

describe('sendTelegramMessage', () => {
  test('fails honestly without a token', async () => {
    const res = await sendTelegramMessage('123', 'hi', {});
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/TELEGRAM_BOT_TOKEN/);
  });

  test('sends when the API accepts it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ ok: true }));
    const res = await sendTelegramMessage('12345', 'test from IGRIS', { TELEGRAM_BOT_TOKEN: '123:abc' });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('12345');
  });
});
