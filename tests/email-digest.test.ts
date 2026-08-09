import { describe, expect, test, vi } from 'vitest';
import { runEmailDigest, type DigestDeps } from '@/lib/agents/email-digest';
import type { CommsItem } from '@/lib/comms';

const email = (sender: string, subject: string): CommsItem => ({
  source: 'email',
  title: `${sender} — ${subject}`,
  sender,
  preview: subject,
  ts: new Date().toISOString(),
  unread: 1,
});

function deps(over: Partial<DigestDeps> = {}): DigestDeps {
  return {
    readEmail: async () => [email('Alice', 'Invoice due'), email('Bob', 'Lunch?')],
    summarize: async (_s, _u) => '• Alice: invoice due (urgent)\n• Bob: lunch',
    send: async () => ({ ok: true, detail: 'sent' }),
    ...over,
  };
}

describe('runEmailDigest', () => {
  test('happy path: reads, summarizes, sends — and passes the summary to Telegram', async () => {
    let sentText = '';
    const res = await runEmailDigest(
      { chatId: '123', limit: 5 },
      deps({ send: async (_id, text) => { sentText = text; return { ok: true, detail: 'sent' }; } }),
    );
    expect(res.ok).toBe(true);
    expect(res.step).toBe('done');
    expect(res.emailsRead).toBe(2);
    expect(res.summary).toContain('Alice');
    expect(sentText).toContain('Inbox digest'); // digest header
    expect(sentText).toContain('Alice'); // the summary body was sent
  });

  test('requires a chat id', async () => {
    const res = await runEmailDigest({ chatId: '   ' }, deps());
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/chat id/i);
  });

  test('fails honestly at the read step when Gmail is not connected', async () => {
    const res = await runEmailDigest({ chatId: '123' }, deps({ readEmail: async () => { throw new Error('NOTION_API_KEY'); } }));
    expect(res.ok).toBe(false);
    expect(res.step).toBe('read');
  });

  test('reports empty inbox instead of sending nothing', async () => {
    const res = await runEmailDigest({ chatId: '123' }, deps({ readEmail: async () => [] }));
    expect(res.ok).toBe(false);
    expect(res.step).toBe('read');
    expect(res.detail).toMatch(/no recent emails/i);
  });

  test('stops at send and keeps the summary when Telegram fails', async () => {
    const res = await runEmailDigest({ chatId: '123' }, deps({ send: async () => ({ ok: false, detail: 'chat not found' }) }));
    expect(res.ok).toBe(false);
    expect(res.step).toBe('send');
    expect(res.summary).toBeTruthy(); // summary preserved so the work isn't lost
    expect(res.detail).toMatch(/chat not found/);
  });

  test('does not send when the brain returns an empty summary', async () => {
    const send = vi.fn(async () => ({ ok: true, detail: 'sent' }));
    const res = await runEmailDigest({ chatId: '123' }, deps({ summarize: async () => '', send }));
    expect(res.ok).toBe(false);
    expect(res.step).toBe('summarize');
    expect(send).not.toHaveBeenCalled();
  });
});
