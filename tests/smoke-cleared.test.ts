import { beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The "start clean" path: seed a temp DB, then wipe the demo business data and
// render every data-heavy page. Seeded-state coverage lives in smoke.test.ts;
// this net catches the opposite failure — a page that crashes when the funnel,
// social presence, and email list are empty (a real client's day-one state).
beforeAll(async () => {
  process.env.FOUNDER_OS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'igris-cleared-')), 'test.db');
  process.env.FUNNEL_PROVIDER = 'seed';
  process.env.GBRAIN_BIN = path.join(tmpdir(), 'igris-no-gbrain-cli');
  const { getDb } = await import('@/lib/data');
  const { resetWorkspace } = await import('@/lib/reset');
  resetWorkspace(getDb(), 'demo'); // getDb() seeds first touch, then we clear it
});

type PageEntry = { file: string; load: () => Promise<{ default: (props?: any) => unknown }>; props?: unknown };

// EVERY page, rendered against a fully-wiped workspace. This is the guarantee
// that "start clean" leaves no page broken — a real client's day-one state.
// social/[platform] is the sole exclusion: with no accounts it correctly
// notFound()s (a 404 by design, covered seeded in smoke.test.ts).
const PAGES: PageEntry[] = [
  { file: 'page.tsx', load: () => import('@/app/page') },
  { file: 'comms/page.tsx', load: () => import('@/app/comms/page') },
  { file: 'social/page.tsx', load: () => import('@/app/social/page') },
  { file: 'social/beehiiv/page.tsx', load: () => import('@/app/social/beehiiv/page') },
  { file: 'content/page.tsx', load: () => import('@/app/content/page') },
  { file: 'agents/page.tsx', load: () => import('@/app/agents/page') },
  { file: 'tasks/page.tsx', load: () => import('@/app/tasks/page') },
  { file: 'skills/page.tsx', load: () => import('@/app/skills/page') },
  { file: 'org/page.tsx', load: () => import('@/app/org/page'), props: { searchParams: {} } },
  { file: 'brain/page.tsx', load: () => import('@/app/brain/page') },
  { file: 'finances/page.tsx', load: () => import('@/app/finances/page') },
  { file: 'funnel/page.tsx', load: () => import('@/app/funnel/page'), props: { searchParams: {} } },
  { file: 'workflows/page.tsx', load: () => import('@/app/workflows/page') },
  { file: 'integrations/page.tsx', load: () => import('@/app/integrations/page') },
  { file: 'roadmap/page.tsx', load: () => import('@/app/roadmap/page') },
  { file: 'analytics/page.tsx', load: () => import('@/app/analytics/page') },
  { file: 'reference/page.tsx', load: () => import('@/app/reference/page') },
  { file: 'settings/page.tsx', load: () => import('@/app/settings/page') },
  { file: 'personas/page.tsx', load: () => import('@/app/personas/page') },
];

describe('cleared-workspace smoke — pages render with the demo wiped', () => {
  test.each(PAGES)('$file renders when empty', async ({ load, props }) => {
    const mod = await load();
    await expect(Promise.resolve(mod.default(props))).resolves.toBeTruthy();
  }, 20_000);
});
