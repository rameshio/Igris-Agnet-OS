import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDb, type FounderDb } from '@/lib/db';
import { seedDatabase } from '@/lib/seed';
import { createCustomAgent } from '@/lib/agents/custom';
import { resetWorkspace } from '@/lib/reset';

let db: FounderDb;
afterEach(() => db?.close());

describe('workspace reset', () => {
  test('activity scope clears logs but keeps demo business content + structure', () => {
    db = openDb(':memory:');
    seedDatabase(db);
    // structure + demo content are present after seed
    const deptCount = db.departments.all().length;
    const agentCount = db.agents.all().length;
    expect(db.funnel.journeys().length).toBeGreaterThan(0);

    resetWorkspace(db, 'activity');

    // logs gone
    expect(db.agentRuns.recent(10)).toHaveLength(0);
    expect(db.agentTasks.all()).toHaveLength(0);
    // structure + demo content untouched
    expect(db.departments.all().length).toBe(deptCount);
    expect(db.agents.all().length).toBe(agentCount);
    expect(db.funnel.journeys().length).toBeGreaterThan(0);
    // not flagged as cleared — the demo is still here
    expect(db.meta.get('demo_cleared')).toBeNull();
  });

  test('demo scope wipes business data, sets the flag, keeps structure + custom agents', () => {
    db = openDb(':memory:');
    seedDatabase(db);
    const custom = createCustomAgent(db, {
      name: 'Client Bot',
      departmentId: 'dept-sales',
      instructions: 'Serve the client.',
    });
    const deptCount = db.departments.all().length;

    resetWorkspace(db, 'demo');

    // demo business data gone
    expect(db.funnel.journeys()).toHaveLength(0);
    expect(db.social.accounts()).toHaveLength(0);
    expect(db.emailList.snapshots()).toHaveLength(0);
    // the seeded roster + tool catalog (business-specific names) are wiped too
    expect(db.agents.all()).toHaveLength(0);
    expect(db.tools.all()).toHaveLength(0);
    // flag set
    expect(db.meta.get('demo_cleared')).toBe('1');
    // neutral scaffolding survives so the app still runs
    expect(db.departments.all().length).toBe(deptCount);
    // the client's own agent is never wiped by a reset
    expect(db.customAgents.get(custom.id)?.name).toBe('Client Bot');
  });

  test('the demo_cleared flag persists across reopen so a reset stays clean', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'igris-reset-')), 'reset.db');
    let d = openDb(file);
    seedDatabase(d);
    resetWorkspace(d, 'demo');
    d.close();

    // Reopen the same file — the flag and the emptiness survive.
    d = openDb(file);
    expect(d.meta.get('demo_cleared')).toBe('1');
    expect(d.funnel.journeys()).toHaveLength(0);
    d.close();
  });
});

describe('reset API', () => {
  beforeAll(() => {
    process.env.FOUNDER_OS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'igris-reset-api-')), 'test.db');
    process.env.LLM_PROVIDER = 'stub';
  });

  test("POST 'activity' keeps demo, POST 'demo' wipes it, bad scope 400s", async () => {
    const { getDb } = await import('@/lib/data');
    const { POST } = await import('@/app/api/admin/reset/route');
    const live = getDb(); // seeds the temp DB
    expect(live.funnel.journeys().length).toBeGreaterThan(0);

    // activity scope keeps demo content
    const r1 = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ scope: 'activity' }) }));
    expect(r1.status).toBe(200);
    expect(live.funnel.journeys().length).toBeGreaterThan(0);

    // a custom agent created before a full reset must survive it
    const survivor = createCustomAgent(live, { name: 'Keeper', departmentId: 'dept-tech', instructions: 'x' });

    // demo scope wipes business data + sets flag
    const r2 = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ scope: 'demo' }) }));
    const body2 = (await r2.json()) as { result: { demoCleared: boolean } };
    expect(body2.result.demoCleared).toBe(true);
    expect(live.funnel.journeys()).toHaveLength(0);
    expect(live.meta.get('demo_cleared')).toBe('1');
    expect(live.customAgents.get(survivor.id)?.name).toBe('Keeper');

    // missing / invalid scope → 400, no wipe
    const r3 = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({}) }));
    expect(r3.status).toBe(400);
    const r4 = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ scope: 'nuke' }) }));
    expect(r4.status).toBe(400);
  });
});
