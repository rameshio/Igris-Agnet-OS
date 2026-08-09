import { describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';

describe('model_provider_connections repo (metadata + health only)', () => {
  test('upsert stores config; absent row means defaults', () => {
    const db = openDb(':memory:');
    expect(db.modelConnections.get('openai')).toBeNull();
    const c = db.modelConnections.upsert('openai', { enabled: false, baseUrl: 'https://proxy.local/v1', displayName: 'My OpenAI' });
    expect(c.enabled).toBe(false);
    expect(c.baseUrl).toBe('https://proxy.local/v1');
    expect(c.displayName).toBe('My OpenAI');
  });

  test('never stores a secret column', () => {
    const db = openDb(':memory:');
    db.modelConnections.upsert('nvidia', {});
    const cols = (db as unknown as { modelConnections: unknown }) && Object.keys(db.modelConnections.get('nvidia')!);
    expect(cols).not.toContain('apiKey');
    expect(cols).not.toContain('api_key');
    expect(cols).not.toContain('secret');
    expect(cols).not.toContain('credential');
  });

  test('recordCheck sets health timestamps and clears/sets error', () => {
    const db = openDb(':memory:');
    const ok = db.modelConnections.recordCheck('groq', { ok: true });
    expect(ok.lastSuccessAt).not.toBeNull();
    expect(ok.lastError).toBeNull();
    const bad = db.modelConnections.recordCheck('groq', { ok: false, error: 'boom' });
    expect(bad.lastError).toBe('boom');
    expect(bad.lastSuccessAt).not.toBeNull(); // prior success preserved
  });

  test('remove clears the row', () => {
    const db = openDb(':memory:');
    db.modelConnections.upsert('mistral', {});
    db.modelConnections.remove('mistral');
    expect(db.modelConnections.get('mistral')).toBeNull();
  });
});
