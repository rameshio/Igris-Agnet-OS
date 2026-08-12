/**
 * Workflow rename + delete/archive over the real HTTP route handlers.
 * The client sends only { name } (rename) or nothing (delete) — the backend
 * decides delete vs archive and validates the name.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDb } from '@/lib/data';
import { PATCH, DELETE, GET } from '@/app/api/flows/[id]/route';
import { GET as GET_LIST } from '@/app/api/flows/route';
import type { WorkflowGraph } from '@/lib/flows/schema';

beforeAll(() => {
  process.env.FOUNDER_OS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'igris-wfadmin-')), 'test.db');
});
afterAll(() => {
  delete process.env.FOUNDER_OS_DB;
});

const graph: WorkflowGraph = { nodes: [{ id: 'in', type: 'input', x: 0, y: 0, config: { value: '', format: 'text' } }], edges: [] };
const ctx = (id: string) => ({ params: { id } });
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://t/api/flows/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), ctx(id));

describe('DELETE /api/flows/:id — policy over HTTP', () => {
  test('history-free workflow → hard delete, leaves the active list', async () => {
    const db = getDb();
    db.flowWorkflows.create({ id: 'wf-a', name: 'AA', graph });
    const res = await DELETE(new Request('http://t/api/flows/wf-a', { method: 'DELETE' }), ctx('wf-a'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: 'deleted' });

    const list = await (await GET_LIST()).json();
    expect(list.workflows.find((w: { id: string }) => w.id === 'wf-a')).toBeUndefined();
  });

  test('workflow with history → archived, and a refresh does not restore it to the list', async () => {
    const db = getDb();
    db.flowWorkflows.create({ id: 'wf-b', name: 'BB', graph });
    db.flowVersions.create({ id: 'wf-b-v1', workflowId: 'wf-b', version: 1, graph });
    const res = await DELETE(new Request('http://t/api/flows/wf-b', { method: 'DELETE' }), ctx('wf-b'));
    expect(await res.json()).toMatchObject({ ok: true, mode: 'archived' });

    const list = await (await GET_LIST()).json();
    expect(list.workflows.find((w: { id: string }) => w.id === 'wf-b')).toBeUndefined();
    // Still fetchable directly (audit), just not listed.
    expect((await GET(new Request('http://t'), ctx('wf-b'))).status).toBe(200);
  });

  test('deleting an unknown workflow → 404', async () => {
    const res = await DELETE(new Request('http://t/api/flows/ghost', { method: 'DELETE' }), ctx('ghost'));
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/flows/:id — rename', () => {
  test('renames and the change is readable back', async () => {
    getDb().flowWorkflows.create({ id: 'wf-r', name: 'Old', graph });
    const res = await patch('wf-r', { name: '  New Name  ' });
    expect(res.status).toBe(200);
    const got = await (await GET(new Request('http://t'), ctx('wf-r'))).json();
    expect(got.workflow.name).toBe('New Name'); // trimmed
  });

  test('a whitespace-only name is rejected (400)', async () => {
    getDb().flowWorkflows.create({ id: 'wf-r2', name: 'Keep', graph });
    const res = await patch('wf-r2', { name: '   ' });
    expect(res.status).toBe(400);
    expect((await (await GET(new Request('http://t'), ctx('wf-r2'))).json()).workflow.name).toBe('Keep');
  });

  test('duplicate names are allowed (id is the identity, not the name)', async () => {
    getDb().flowWorkflows.create({ id: 'wf-d1', name: 'Dup', graph });
    getDb().flowWorkflows.create({ id: 'wf-d2', name: 'Other', graph });
    const res = await patch('wf-d2', { name: 'Dup' });
    expect(res.status).toBe(200);
  });
});
