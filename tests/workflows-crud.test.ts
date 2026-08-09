import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb, type FounderDb } from '@/lib/db';
import { createWorkflow, updateWorkflow } from '@/lib/workflows-crud';

let db: FounderDb;
afterEach(() => db?.close());

describe('workflow builder repo', () => {
  test('create assigns ids/order and fills step defaults from a simple payload', () => {
    db = openDb(':memory:');
    const wf = createWorkflow(db, {
      name: 'Client onboarding',
      subtitle: 'From signed to shipped',
      steps: [
        { title: 'Kickoff call', ownerKind: 'human', owner: 'You', tools: ['zoom', 'notion'] },
        { title: 'Provision workspace', ownerKind: 'agent', owner: 'Onboarding Agent', tools: ['slack'] },
      ],
    });
    expect(wf.id).toMatch(/^wf-/);
    expect(wf.order).toBe(0);
    expect(wf.steps).toHaveLength(2);
    expect(wf.steps[0].id).toMatch(/^step-/);
    expect(wf.steps[0].tools).toEqual(['zoom', 'notion']);
    // advanced analytics fields default safely
    expect(wf.steps[0].leakUsd).toBeNull();
    expect(wf.steps[0].automation).toBeNull();
    // persisted + readable back through Zod
    expect(db.workflows.get(wf.id)?.name).toBe('Client onboarding');
  });

  test('order increments across creates', () => {
    db = openDb(':memory:');
    const a = createWorkflow(db, { name: 'A', steps: [{ title: 's', owner: 'x', ownerKind: 'agent', tools: [] }] });
    const b = createWorkflow(db, { name: 'B', steps: [{ title: 's', owner: 'x', ownerKind: 'agent', tools: [] }] });
    expect(b.order).toBe(a.order + 1);
  });

  test('update replaces editable fields, keeps id + order', () => {
    db = openDb(':memory:');
    const wf = createWorkflow(db, { name: 'Draft', steps: [{ title: 's1', owner: 'x', ownerKind: 'agent', tools: [] }] });
    const updated = updateWorkflow(db, wf.id, {
      name: 'Final',
      subtitle: 'now with tools',
      steps: [{ title: 's1', owner: 'x', ownerKind: 'agent', tools: ['stripe'] }],
    });
    expect(updated.id).toBe(wf.id);
    expect(updated.order).toBe(wf.order);
    expect(updated.name).toBe('Final');
    expect(updated.steps[0].tools).toEqual(['stripe']);
  });

  test('update throws on unknown id', () => {
    db = openDb(':memory:');
    expect(() => updateWorkflow(db, 'wf-nope', { name: 'x', steps: [{ title: 't', owner: 'o', ownerKind: 'agent', tools: [] }] })).toThrow(/unknown workflow/i);
  });

  test('rejects an empty payload (no name, no steps)', () => {
    db = openDb(':memory:');
    expect(() => createWorkflow(db, { name: '', steps: [] })).toThrow();
    expect(() => createWorkflow(db, { name: 'ok', steps: [] })).toThrow(); // needs >= 1 step
  });
});

describe('workflow API', () => {
  beforeAll(() => {
    process.env.FOUNDER_OS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'igris-wf-api-')), 'test.db');
    process.env.LLM_PROVIDER = 'stub';
  });

  test('POST creates, GET lists, PATCH edits, DELETE removes', async () => {
    const collection = await import('@/app/api/workflows/route');
    const single = await import('@/app/api/workflows/[id]/route');

    const created = await collection.POST(
      new Request('http://x/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'Lead to close', steps: [{ title: 'Reply fast', owner: 'SDR', ownerKind: 'agent', tools: ['slack'] }] }),
      }),
    );
    expect(created.status).toBe(201);
    const { workflow } = (await created.json()) as { workflow: { id: string } };
    expect(workflow.id).toMatch(/^wf-/);

    const listed = await (await collection.GET()).json();
    expect(listed.workflows.some((w: { id: string }) => w.id === workflow.id)).toBe(true);

    const patched = await single.PATCH(
      new Request('http://x', { method: 'PATCH', body: JSON.stringify({ name: 'Lead to close v2', steps: [{ title: 'Reply fast', owner: 'SDR', ownerKind: 'agent', tools: ['slack', 'stripe'] }] }) }),
      { params: { id: workflow.id } },
    );
    expect((await patched.json()).workflow.name).toBe('Lead to close v2');

    const removed = single.DELETE(new Request('http://x'), { params: { id: workflow.id } });
    expect((await removed.json()).ok).toBe(true);

    const missing = await single.PATCH(new Request('http://x', { method: 'PATCH', body: '{}' }), { params: { id: workflow.id } });
    expect(missing.status).toBe(404);
  });

  test('POST rejects an invalid payload with 400', async () => {
    const collection = await import('@/app/api/workflows/route');
    const res = await collection.POST(new Request('http://x/api/workflows', { method: 'POST', body: JSON.stringify({ name: '' }) }));
    expect(res.status).toBe(400);
  });
});
