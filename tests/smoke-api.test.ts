import { beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

beforeAll(() => {
  process.env.FOUNDER_OS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'founder-os-apismoke-')), 'test.db');
  process.env.FUNNEL_PROVIDER = 'seed'; // keep /api/funnel off the live Attio API in tests
});

type RouteEntry = {
  route: string; // path under app/api, source of truth for coverage
  load: () => Promise<{ GET?: (req: Request, ctx?: any) => unknown }>;
  url: string; // includes any required query params
  params?: Record<string, string>; // for dynamic [param] routes
};

// Every app/api/**/route.ts that exports GET, with valid params so each returns
// a real 200 (not a 400/404 for a missing arg). Live-connector routes
// (connections, social/sync) must still answer 200 with honest state.
const ROUTES: RouteEntry[] = [
  { route: 'activity', load: () => import('@/app/api/activity/route'), url: 'http://localhost/api/activity?limit=5' },
  { route: 'agents', load: () => import('@/app/api/agents/route'), url: 'http://localhost/api/agents' },
  { route: 'agents/activity', load: () => import('@/app/api/agents/activity/route'), url: 'http://localhost/api/agents/activity?limit=5' },
  { route: 'agents/broadcast', load: () => import('@/app/api/agents/broadcast/route'), url: 'http://localhost/api/agents/broadcast' },
  { route: 'agents/presence', load: () => import('@/app/api/agents/presence/route'), url: 'http://localhost/api/agents/presence' },
  { route: 'agents/resolve', load: () => import('@/app/api/agents/resolve/route'), url: 'http://localhost/api/agents/resolve?capabilities=research.web' },
  { route: 'capabilities', load: () => import('@/app/api/capabilities/route'), url: 'http://localhost/api/capabilities' },
  { route: 'agent-flows', load: () => import('@/app/api/agent-flows/route'), url: 'http://localhost/api/agent-flows' },
  { route: 'agents/work', load: () => import('@/app/api/agents/work/route'), url: 'http://localhost/api/agents/work?agentId=data-agent' },
  { route: 'brain', load: () => import('@/app/api/brain/route'), url: 'http://localhost/api/brain' },
  { route: 'models', load: () => import('@/app/api/models/route'), url: 'http://localhost/api/models' },
  { route: 'flows', load: () => import('@/app/api/flows/route'), url: 'http://localhost/api/flows' },
  { route: 'home', load: () => import('@/app/api/home/route'), url: 'http://localhost/api/home' },
  { route: 'flow-approvals', load: () => import('@/app/api/flow-approvals/route'), url: 'http://localhost/api/flow-approvals' },
  { route: 'flow-approvals/cards', load: () => import('@/app/api/flow-approvals/cards/route'), url: 'http://localhost/api/flow-approvals/cards' },
  { route: 'brain/graph', load: () => import('@/app/api/brain/graph/route'), url: 'http://localhost/api/brain/graph' },
  { route: 'brain/overview', load: () => import('@/app/api/brain/overview/route'), url: 'http://localhost/api/brain/overview' },
  { route: 'brain/entities', load: () => import('@/app/api/brain/entities/route'), url: 'http://localhost/api/brain/entities' },
  { route: 'brain/knowledge', load: () => import('@/app/api/brain/knowledge/route'), url: 'http://localhost/api/brain/knowledge' },
  { route: 'brain/sources', load: () => import('@/app/api/brain/sources/route'), url: 'http://localhost/api/brain/sources' },
  { route: 'brain/search', load: () => import('@/app/api/brain/search/route'), url: 'http://localhost/api/brain/search?q=test' },
  { route: 'brain/radial', load: () => import('@/app/api/brain/radial/route'), url: 'http://localhost/api/brain/radial' },
  { route: 'comms', load: () => import('@/app/api/comms/route'), url: 'http://localhost/api/comms' },
  { route: 'conductor/context', load: () => import('@/app/api/conductor/context/route'), url: 'http://localhost/api/conductor/context?path=/agents' },
  { route: 'connections', load: () => import('@/app/api/connections/route'), url: 'http://localhost/api/connections' },
  { route: 'connections/telegram/test', load: () => import('@/app/api/connections/telegram/test/route'), url: 'http://localhost/api/connections/telegram/test' },
  { route: 'contacts/tags', load: () => import('@/app/api/contacts/tags/route'), url: 'http://localhost/api/contacts/tags' },
  { route: 'departments', load: () => import('@/app/api/departments/route'), url: 'http://localhost/api/departments' },
  { route: 'funnel', load: () => import('@/app/api/funnel/route'), url: 'http://localhost/api/funnel' },
  { route: 'funnel/lead-message', load: () => import('@/app/api/funnel/lead-message/route'), url: 'http://localhost/api/funnel/lead-message?name=Smoke%20Test%20Lead' },
  { route: 'keys', load: () => import('@/app/api/keys/route'), url: 'http://localhost/api/keys' },
  { route: 'life/map', load: () => import('@/app/api/life/map/route'), url: 'http://localhost/api/life/map' },
  { route: 'metrics', load: () => import('@/app/api/metrics/route'), url: 'http://localhost/api/metrics' },
  { route: 'missions', load: () => import('@/app/api/missions/route'), url: 'http://localhost/api/missions' },
  { route: 'company-tasks/[id]/dependencies', load: () => import('@/app/api/company-tasks/[id]/dependencies/route'), url: 'http://localhost/api/company-tasks/smoke/dependencies', params: { id: 'smoke' } },
  { route: 'missions/[id]/events', load: () => import('@/app/api/missions/[id]/events/route'), url: 'http://localhost/api/missions/smoke/events', params: { id: 'smoke' } },
  { route: 'missions/[id]/proposals', load: () => import('@/app/api/missions/[id]/proposals/route'), url: 'http://localhost/api/missions/smoke/proposals', params: { id: 'smoke' } },
  { route: 'roadmap', load: () => import('@/app/api/roadmap/route'), url: 'http://localhost/api/roadmap' },
  { route: 'settings/brain', load: () => import('@/app/api/settings/brain/route'), url: 'http://localhost/api/settings/brain' },
  { route: 'social', load: () => import('@/app/api/social/route'), url: 'http://localhost/api/social' },
  { route: 'social/[platform]', load: () => import('@/app/api/social/[platform]/route'), url: 'http://localhost/api/social/instagram', params: { platform: 'instagram' } },
  { route: 'social/history', load: () => import('@/app/api/social/history/route'), url: 'http://localhost/api/social/history?limit=6' },
  { route: 'social/posts', load: () => import('@/app/api/social/posts/route'), url: 'http://localhost/api/social/posts' },
  { route: 'social/series', load: () => import('@/app/api/social/series/route'), url: 'http://localhost/api/social/series?metric=audience' },
  { route: 'social/sync', load: () => import('@/app/api/social/sync/route'), url: 'http://localhost/api/social/sync' },
  { route: 'tools', load: () => import('@/app/api/tools/route'), url: 'http://localhost/api/tools' },
  { route: 'ventures', load: () => import('@/app/api/ventures/route'), url: 'http://localhost/api/ventures' },
  { route: 'workflows', load: () => import('@/app/api/workflows/route'), url: 'http://localhost/api/workflows' },
  { route: 'webhooks/manychat', load: () => import('@/app/api/webhooks/manychat/route'), url: 'http://localhost/api/webhooks/manychat' },
];

function discoverGetRoutes(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...discoverGetRoutes(path.join(dir, entry.name), rel));
    else if (entry.name === 'route.ts') {
      const src = readFileSync(path.join(dir, entry.name), 'utf8');
      if (/export\s+(async\s+)?function\s+GET/.test(src)) out.push(rel.replace(/\/route\.ts$/, ''));
    }
  }
  return out;
}

describe('platform smoke — every GET API route answers 200 with JSON', () => {
  test.each(ROUTES)('GET /api/$route', async ({ load, url, params }) => {
    const mod = await load();
    expect(mod.GET, 'route should export GET').toBeTypeOf('function');
    const res = (await mod.GET!(new Request(url), { params })) as Response;
    expect(res.status, `GET ${url} should be 200 (honest state, not 500/400)`).toBe(200);
    const body = await res.json();
    expect(body && typeof body === 'object').toBe(true);
  }, 20_000);

  test('the API smoke net covers every GET route under app/api (no route escapes)', () => {
    // skills/[slug] reads the local ~/.claude/skills dir at runtime (404 without
    // a slug on disk), so it is not a 200-required smoke route. flows/[id] and
    // flows/[id]/versions likewise 404 without a real workflow id — they are
    // covered by the dedicated flows repo/route tests instead.
    // settings/hermes-runtime GET probes the real Hermes binary + serve endpoint
    // (environment-dependent, slow, may launch the Hermes CLI), so it is not a
    // 200-required smoke route — it is covered by tests/hermes-runtime.test.ts.
    // flow-approvals/[id] GET 404s without a real approval id — covered by tests/flow-approvals.test.ts.
    // agents/[id]/capabilities GET 404s without a real agent id — covered by tests/capabilities-registry.test.ts.
    // company mission/task GETs 404 without real ids — covered by tests/company-service.test.ts.
    // missions/[id]/report + company-artifacts/[id] GET 404 without real ids — covered by tests/company-manager*.test.ts.
    // brain entity/knowledge single-item GETs 404 without a real id — covered by tests/brain-core-*.test.ts.
    // brain/inspect needs a real kind+id (404 otherwise) — covered by tests/brain-inspector.test.ts.
    const IGNORE = new Set(['skills/[slug]', 'flows/[id]', 'flows/[id]/versions', 'flows/[id]/runs', 'flows/runs/[runId]', 'flow-approvals/[id]', 'settings/hermes-runtime', 'agents/[id]/capabilities', 'missions/[id]', 'missions/[id]/tasks', 'company-tasks/[id]', 'company-tasks/[id]/eligible-agents', 'missions/[id]/report', 'company-artifacts/[id]', 'brain/entities/[id]', 'brain/entities/[id]/relationships', 'brain/knowledge/[id]', 'brain/inspect']);
    const discovered = discoverGetRoutes(path.join(process.cwd(), 'app', 'api')).filter((r) => !IGNORE.has(r)).sort();
    const covered = ROUTES.map((r) => r.route).sort();
    expect(covered).toEqual(discovered);
  });
});
