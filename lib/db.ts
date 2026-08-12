import Database from 'better-sqlite3';
import { isValidCron } from '@/lib/cron';
import type { WorkflowGraph } from '@/lib/flows/schema';
import type {
  FlowRun,
  FlowNodeRun,
  RunStatus,
  NodeRunStatus,
  NodeOutput,
  StartRunInput,
  FlowApproval,
  ApprovalStatus,
  ApprovalRequestType,
} from '@/lib/flows/run-types';
import {
  AgentCronSchema,
  AgentMessageSchema,
  AgentRunSchema,
  AgentSchema,
  AgentTaskSchema,
  AgentFlowSchema,
  CustomAgentSchema,
  BroadcastReplySchema,
  BroadcastSchema,
  ContactTagSchema,
  DepartmentSchema,
  DomainSchema,
  MetricSchema,
  PersonaSchema,
  PhaseSchema,
  RoadmapItemSchema,
  SocialAccountSchema,
  SocialSnapshotSchema,
  EmailListSnapshotSchema,
  SocialDmSchema,
  SocialDmSnapshotSchema,
  SocialDmMessageSchema,
  SocialPostSchema,
  FunnelContactSchema,
  FunnelTouchSchema,
  FunnelJourneySchema,
  PersonSchema,
  SopTaskSchema,
  WorkflowSchema,
  SkillSchema,
  ToolSchema,
  type Agent,
  type AgentCron,
  type AgentMessage,
  type AgentRun,
  type AgentTask,
  type AgentFlow,
  type Broadcast,
  type BroadcastReply,
  type ContactTag,
  type CustomAgent,
  type Department,
  type Domain,
  type Metric,
  type Persona,
  type Phase,
  type RoadmapItem,
  type SocialAccount,
  type SocialPlatform,
  type SocialSnapshot,
  type EmailListSnapshot,
  type SocialDm,
  type SocialDmSnapshot,
  type SocialDmMessage,
  type SocialPost,
  type FunnelContact,
  type FunnelTouch,
  type FunnelJourney,
  type FunnelVenture,
  type Person,
  type SopTask,
  type Workflow,
  type Skill,
  type Tool,
} from '@/lib/schemas';

const DDL = `
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  tagline TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,
  "order" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES departments(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  tier TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS custom_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL,
  instructions TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_flows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nodes TEXT NOT NULL DEFAULT '[]',
  edges TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- /flows orchestrator (Phase A). A workflow's editable draft graph lives on the
-- workflow row; published versions are immutable snapshots. Runs (Phase C) will
-- reference a version so historical runs always have a stable definition.
CREATE TABLE IF NOT EXISTS flow_workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  draft_graph TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  current_version INTEGER,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS flow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  graph TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, version)
);
-- App-wide model-provider connection state (Phase B). Metadata + health ONLY.
-- The API secret NEVER lives here — it stays in .env.local; has_credential is
-- derived from the env at read time, not stored.
CREATE TABLE IF NOT EXISTS model_provider_connections (
  provider_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  base_url TEXT,
  last_check_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Workflow EXECUTION history (Phase C). One run of one immutable version; per-node
-- records. Runtime status lives here only — never written back into the graph.
CREATE TABLE IF NOT EXISTS flow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  starting_input TEXT NOT NULL DEFAULT '{}',
  current_node_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  error_code TEXT,
  error_message TEXT,
  total_tokens INTEGER,
  estimated_cost REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS flow_node_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  provider_id TEXT,
  model_id TEXT,
  model_strategy TEXT,
  adapter TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  estimated_cost REAL,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flow_runs_workflow ON flow_runs (workflow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_flow_node_runs_run ON flow_node_runs (run_id);
-- Human Approval gates (Phase E). A durable pause-point: a run waiting on a
-- Human Approval node has a pending row here; a human resolves it and the run
-- resumes. Additive/idempotent. context_json holds NON-SECRET workflow data only
-- (never credentials/tokens) -- see docs/SECURITY.md.
CREATE TABLE IF NOT EXISTS flow_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_run_id TEXT,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  request_type TEXT NOT NULL DEFAULT 'workflow',
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  context_json TEXT,
  approval_route TEXT NOT NULL DEFAULT 'approve',
  rejection_route TEXT NOT NULL DEFAULT 'reject',
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flow_approvals_run ON flow_approvals (run_id);
CREATE INDEX IF NOT EXISTS idx_flow_approvals_status ON flow_approvals (status, created_at);
CREATE INDEX IF NOT EXISTS idx_flow_approvals_node_run ON flow_approvals (node_run_id);
CREATE TABLE IF NOT EXISTS roadmap_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  quarter TEXT NOT NULL,
  status TEXT NOT NULL,
  department_id TEXT,
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  delta REAL NOT NULL DEFAULT 0,
  period TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  color TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  ord INTEGER NOT NULL,
  name TEXT NOT NULL,
  archetype TEXT NOT NULL,
  tagline TEXT NOT NULL,
  summary TEXT NOT NULL,
  accent TEXT NOT NULL,
  north_star TEXT NOT NULL,
  pillars TEXT NOT NULL DEFAULT '[]',
  connectors TEXT NOT NULL DEFAULT '[]',
  metrics TEXT NOT NULL DEFAULT '[]',
  brain_use TEXT NOT NULL,
  signature_play TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS phases (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS broadcasts (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_crons (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  schedule TEXT NOT NULL,
  description TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_tags (
  person TEXT NOT NULL,
  channel TEXT NOT NULL,
  tag TEXT NOT NULL,
  tier INTEGER NOT NULL,
  PRIMARY KEY (person, channel)
);
CREATE TABLE IF NOT EXISTS social_accounts (
  platform TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  url TEXT,
  "order" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS social_snapshots (
  platform TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  followers INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (platform, captured_at)
);
CREATE TABLE IF NOT EXISTS broadcast_replies (
  id TEXT PRIMARY KEY,
  broadcast_id TEXT NOT NULL REFERENCES broadcasts(id),
  agent_id TEXT NOT NULL,
  ok INTEGER NOT NULL,
  reply TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_list_snapshots (
  captured_at TEXT PRIMARY KEY,
  subscribers INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS social_dms (
  platform TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS social_dm_snapshots (
  platform TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  count INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (platform, captured_at)
);
CREATE TABLE IF NOT EXISTS social_dm_messages (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  name TEXT NOT NULL,
  handle TEXT,
  text TEXT NOT NULL,
  direction TEXT NOT NULL,
  tag TEXT,
  ts TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_dm_messages_ts ON social_dm_messages (ts);
CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  caption TEXT NOT NULL,
  media_url TEXT,
  platforms TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_for TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES departments(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  tools TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS sop_tasks (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES departments(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  assignee_kind TEXT NOT NULL,
  assignee_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS funnel_contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  venture TEXT NOT NULL,
  status TEXT NOT NULL,
  product TEXT,
  amount_usd REAL,
  relationship TEXT NOT NULL DEFAULT 'warm',
  likelihood INTEGER NOT NULL DEFAULT 50,
  email TEXT,
  phone TEXT,
  person TEXT,
  company TEXT,
  role TEXT,
  linkedin TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS funnel_touches (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES funnel_contacts(id),
  seq INTEGER NOT NULL,
  stage TEXT NOT NULL,
  channel TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  revenue_usd INTEGER NOT NULL DEFAULT 0,
  ord INTEGER NOT NULL DEFAULT 0,
  steps TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  tools TEXT NOT NULL DEFAULT '[]',
  markdown TEXT NOT NULL DEFAULT '',
  ord INTEGER NOT NULL DEFAULT 0
);
`;

/** Databases created before the hierarchy build lack these columns. */
function migrateAgentsTable(db: InstanceType<typeof Database>): void {
  const columns = new Set(
    (db.pragma('table_info(agents)') as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('parent_id')) db.exec('ALTER TABLE agents ADD COLUMN parent_id TEXT');
  if (!columns.has('instance')) db.exec("ALTER TABLE agents ADD COLUMN instance TEXT NOT NULL DEFAULT 'builtin'");
}

/** Databases created before the funnel-space build lack these columns. */
function migrateFunnelContactsTable(db: InstanceType<typeof Database>): void {
  const columns = new Set(
    (db.pragma('table_info(funnel_contacts)') as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('relationship')) db.exec("ALTER TABLE funnel_contacts ADD COLUMN relationship TEXT NOT NULL DEFAULT 'warm'");
  if (!columns.has('likelihood')) db.exec('ALTER TABLE funnel_contacts ADD COLUMN likelihood INTEGER NOT NULL DEFAULT 50');
  if (!columns.has('email')) db.exec('ALTER TABLE funnel_contacts ADD COLUMN email TEXT');
  if (!columns.has('phone')) db.exec('ALTER TABLE funnel_contacts ADD COLUMN phone TEXT');
  // dossier identity (Round 15) — the human behind the deal
  for (const col of ['person', 'company', 'role', 'linkedin']) {
    if (!columns.has(col)) db.exec(`ALTER TABLE funnel_contacts ADD COLUMN ${col} TEXT`);
  }
}

// Skills gained a `markdown` (SKILL.md) column after first ship. Add it, and
// clear the stale rows so the re-seed backfills each skill's doc.
function migrateSkillsTable(db: InstanceType<typeof Database>): void {
  const columns = new Set((db.pragma('table_info(skills)') as { name: string }[]).map((c) => c.name));
  if (columns.size > 0 && !columns.has('markdown')) {
    db.exec("ALTER TABLE skills ADD COLUMN markdown TEXT NOT NULL DEFAULT ''");
    db.exec('DELETE FROM skills');
  }
}

// custom_agents gained a `tools` column so an agent can carry connectable
// tools; back-fill databases created before it with an empty list.
function migrateCustomAgentsTable(db: InstanceType<typeof Database>): void {
  const columns = new Set(
    (db.pragma('table_info(custom_agents)') as { name: string }[]).map((c) => c.name),
  );
  if (columns.size > 0 && !columns.has('tools')) {
    db.exec("ALTER TABLE custom_agents ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'");
  }
}

// agent_runs gained LLM cost columns after first ship: the model used and the
// token usage + estimated cost, so /agents can show runtime and spend.
function migrateAgentRunsTable(db: InstanceType<typeof Database>): void {
  const columns = new Set(
    (db.pragma('table_info(agent_runs)') as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('model')) db.exec('ALTER TABLE agent_runs ADD COLUMN model TEXT');
  if (!columns.has('tokens_in')) db.exec('ALTER TABLE agent_runs ADD COLUMN tokens_in INTEGER');
  if (!columns.has('tokens_out')) db.exec('ALTER TABLE agent_runs ADD COLUMN tokens_out INTEGER');
  if (!columns.has('cost_usd')) db.exec('ALTER TABLE agent_runs ADD COLUMN cost_usd REAL');
}

// /flows workflows gained soft-archive after first ship: a workflow with run or
// version history is archived (hidden) instead of hard-deleted so immutable
// versions and run/approval audit records survive. Additive + idempotent.
function migrateFlowWorkflowsTable(db: InstanceType<typeof Database>): void {
  const columns = new Set(
    (db.pragma('table_info(flow_workflows)') as { name: string }[]).map((c) => c.name),
  );
  if (columns.size > 0 && !columns.has('archived_at')) db.exec('ALTER TABLE flow_workflows ADD COLUMN archived_at TEXT');
}

type AgentRow = {
  id: string;
  department_id: string;
  name: string;
  role: string;
  status: string;
  tier: string;
  description: string;
  model: string;
  tools: string;
  parent_id: string | null;
  instance: string;
};

function rowToAgent(row: AgentRow): Agent {
  return AgentSchema.parse({
    id: row.id,
    departmentId: row.department_id,
    name: row.name,
    role: row.role,
    status: row.status,
    tier: row.tier,
    description: row.description,
    model: row.model,
    tools: JSON.parse(row.tools),
    parentId: row.parent_id,
    instance: row.instance,
  });
}

export function openDb(path: string) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(DDL);
  migrateAgentsTable(db);
  migrateFunnelContactsTable(db);
  migrateSkillsTable(db);
  migrateCustomAgentsTable(db);
  migrateAgentRunsTable(db);
  migrateFlowWorkflowsTable(db);

  const departments = {
    all(): Department[] {
      return db
        .prepare('SELECT * FROM departments ORDER BY "order"')
        .all()
        .map((r) => DepartmentSchema.parse(r));
    },
    insert(d: Department): void {
      db.prepare(
        'INSERT OR REPLACE INTO departments (id, name, slug, tagline, color, "order") VALUES (?, ?, ?, ?, ?, ?)',
      ).run(d.id, d.name, d.slug, d.tagline, d.color, d.order);
    },
    deleteWhereIdNotIn(ids: string[]): void {
      const placeholders = ids.map(() => '?').join(', ');
      db.prepare(`DELETE FROM departments WHERE id NOT IN (${placeholders})`).run(...ids);
    },
  };

  const agents = {
    all(): Agent[] {
      return (db.prepare('SELECT * FROM agents ORDER BY tier, name').all() as AgentRow[]).map(rowToAgent);
    },
    byDepartment(departmentId: string): Agent[] {
      return (
        db
          .prepare('SELECT * FROM agents WHERE department_id = ? ORDER BY tier, name')
          .all(departmentId) as AgentRow[]
      ).map(rowToAgent);
    },
    insert(a: Agent): void {
      db.prepare(
        'INSERT OR REPLACE INTO agents (id, department_id, name, role, status, tier, description, model, tools, parent_id, instance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        a.id, a.departmentId, a.name, a.role, a.status, a.tier, a.description, a.model,
        JSON.stringify(a.tools), a.parentId, a.instance,
      );
    },
    deleteWhereIdNotIn(ids: string[]): void {
      const placeholders = ids.map(() => '?').join(', ');
      db.prepare(`DELETE FROM agents WHERE id NOT IN (${placeholders})`).run(...ids);
    },
  };

  const rowToCustomAgent = (r: any): CustomAgent =>
    CustomAgentSchema.parse({
      id: r.id,
      name: r.name,
      description: r.description,
      departmentId: r.department_id,
      instructions: r.instructions,
      model: r.model,
      tools: JSON.parse(r.tools ?? '[]'),
      enabled: Boolean(r.enabled),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });

  const customAgents = {
    all(): CustomAgent[] {
      return db
        .prepare('SELECT * FROM custom_agents ORDER BY created_at DESC, rowid DESC')
        .all()
        .map(rowToCustomAgent);
    },
    get(id: string): CustomAgent | null {
      const row = db.prepare('SELECT * FROM custom_agents WHERE id = ?').get(id);
      return row ? rowToCustomAgent(row) : null;
    },
    insert(a: CustomAgent): void {
      CustomAgentSchema.parse(a);
      db.prepare(
        'INSERT OR REPLACE INTO custom_agents (id, name, description, department_id, instructions, model, tools, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        a.id, a.name, a.description, a.departmentId, a.instructions, a.model,
        JSON.stringify(a.tools), a.enabled ? 1 : 0, a.createdAt, a.updatedAt,
      );
    },
    remove(id: string): void {
      db.prepare('DELETE FROM custom_agents WHERE id = ?').run(id);
    },
  };

  const rowToAgentFlow = (r: any): AgentFlow =>
    AgentFlowSchema.parse({
      id: r.id,
      name: r.name,
      nodes: JSON.parse(r.nodes ?? '[]'),
      edges: JSON.parse(r.edges ?? '[]'),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });

  const agentFlows = {
    all(): AgentFlow[] {
      return db.prepare('SELECT * FROM agent_flows ORDER BY updated_at DESC').all().map(rowToAgentFlow);
    },
    get(id: string): AgentFlow | null {
      const row = db.prepare('SELECT * FROM agent_flows WHERE id = ?').get(id);
      return row ? rowToAgentFlow(row) : null;
    },
    upsert(f: AgentFlow): void {
      AgentFlowSchema.parse(f);
      db.prepare(
        'INSERT OR REPLACE INTO agent_flows (id, name, nodes, edges, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(f.id, f.name, JSON.stringify(f.nodes), JSON.stringify(f.edges), f.createdAt, f.updatedAt);
    },
    remove(id: string): void {
      db.prepare('DELETE FROM agent_flows WHERE id = ?').run(id);
    },
  };

  // A tiny key/value store for instance-level flags — e.g. `demo_cleared`, set
  // once a workspace is reset so seedDatabase never repopulates the demo data.
  const meta = {
    get(key: string): string | null {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    set(key: string, value: string): void {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
    },
  };

  // ── /flows orchestrator repos (Phase A). Definition (draft + immutable
  //    versions) only — run history is Phase C.
  type FlowWorkflowRow = {
    id: string;
    name: string;
    description: string;
    draft_graph: string;
    current_version: number | null;
    archived_at: string | null;
    created_at: string;
    updated_at: string;
  };
  type FlowVersionRow = { id: string; workflow_id: string; version: number; graph: string; created_at: string };

  const parseGraph = (s: string): WorkflowGraph => {
    try {
      return JSON.parse(s) as WorkflowGraph;
    } catch {
      return { nodes: [], edges: [] };
    }
  };
  const rowToWorkflow = (r: FlowWorkflowRow) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    draftGraph: parseGraph(r.draft_graph),
    currentVersion: r.current_version,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const flowWorkflows = {
    /** Active workflows only. Pass { includeArchived:true } to include soft-archived rows. */
    all(opts?: { includeArchived?: boolean }) {
      const sql = opts?.includeArchived
        ? 'SELECT * FROM flow_workflows ORDER BY updated_at DESC'
        : 'SELECT * FROM flow_workflows WHERE archived_at IS NULL ORDER BY updated_at DESC';
      return db.prepare(sql).all().map((r) => rowToWorkflow(r as FlowWorkflowRow));
    },
    get(id: string) {
      const r = db.prepare('SELECT * FROM flow_workflows WHERE id = ?').get(id) as FlowWorkflowRow | undefined;
      return r ? rowToWorkflow(r) : null;
    },
    /** True if the workflow has audit-worthy history: any published version OR any run. */
    hasHistory(id: string): boolean {
      const v = db.prepare('SELECT 1 FROM flow_versions WHERE workflow_id = ? LIMIT 1').get(id);
      if (v) return true;
      const r = db.prepare('SELECT 1 FROM flow_runs WHERE workflow_id = ? LIMIT 1').get(id);
      return !!r;
    },
    create(input: { id: string; name: string; description?: string; graph: WorkflowGraph }) {
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO flow_workflows (id, name, description, draft_graph, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
      ).run(input.id, input.name, input.description ?? '', JSON.stringify(input.graph), now, now);
      return this.get(input.id)!;
    },
    saveDraft(id: string, graph: WorkflowGraph) {
      db.prepare('UPDATE flow_workflows SET draft_graph = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(graph),
        new Date().toISOString(),
        id,
      );
    },
    updateMeta(id: string, patch: { name?: string; description?: string }) {
      const cur = this.get(id);
      if (!cur) return;
      db.prepare('UPDATE flow_workflows SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(
        patch.name ?? cur.name,
        patch.description ?? cur.description,
        new Date().toISOString(),
        id,
      );
    },
    setCurrentVersion(id: string, version: number) {
      db.prepare('UPDATE flow_workflows SET current_version = ?, updated_at = ? WHERE id = ?').run(
        version,
        new Date().toISOString(),
        id,
      );
    },
    /** Soft-archive: hide from the active list while preserving versions/runs/approvals. */
    archive(id: string) {
      db.prepare('UPDATE flow_workflows SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL').run(
        new Date().toISOString(),
        new Date().toISOString(),
        id,
      );
    },
    unarchive(id: string) {
      db.prepare('UPDATE flow_workflows SET archived_at = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    },
    /**
     * Hard delete — ONLY safe for a workflow with no history (no versions, no runs).
     * Callers must gate on hasHistory(); the service layer (workflow-admin) does.
     * Deletes the (empty) version set + the draft row; never touches run/approval audit.
     */
    remove(id: string) {
      db.prepare('DELETE FROM flow_versions WHERE workflow_id = ?').run(id);
      db.prepare('DELETE FROM flow_workflows WHERE id = ?').run(id);
    },
  };

  const flowVersions = {
    forWorkflow(workflowId: string) {
      return db
        .prepare('SELECT id, workflow_id, version, created_at FROM flow_versions WHERE workflow_id = ? ORDER BY version DESC')
        .all(workflowId)
        .map((r) => {
          const row = r as Omit<FlowVersionRow, 'graph'>;
          return { id: row.id, workflowId: row.workflow_id, version: row.version, createdAt: row.created_at };
        });
    },
    get(workflowId: string, version: number) {
      const r = db
        .prepare('SELECT * FROM flow_versions WHERE workflow_id = ? AND version = ?')
        .get(workflowId, version) as FlowVersionRow | undefined;
      return r ? { id: r.id, workflowId: r.workflow_id, version: r.version, graph: parseGraph(r.graph), createdAt: r.created_at } : null;
    },
    nextVersion(workflowId: string): number {
      const row = db.prepare('SELECT MAX(version) AS m FROM flow_versions WHERE workflow_id = ?').get(workflowId) as { m: number | null };
      return (row.m ?? 0) + 1;
    },
    create(input: { id: string; workflowId: string; version: number; graph: WorkflowGraph }) {
      db.prepare('INSERT INTO flow_versions (id, workflow_id, version, graph, created_at) VALUES (?, ?, ?, ?, ?)').run(
        input.id,
        input.workflowId,
        input.version,
        JSON.stringify(input.graph),
        new Date().toISOString(),
      );
    },
  };

  // ── Model-provider connection state (Phase B). Metadata + health only; the
  //    secret stays in .env.local. Absent row = defaults (enabled, no override).
  type ModelConnRow = {
    provider_id: string;
    display_name: string;
    enabled: number;
    base_url: string | null;
    last_check_at: string | null;
    last_success_at: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  };
  const rowToModelConn = (r: ModelConnRow) => ({
    providerId: r.provider_id,
    displayName: r.display_name,
    enabled: r.enabled === 1,
    baseUrl: r.base_url,
    lastCheckAt: r.last_check_at,
    lastSuccessAt: r.last_success_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const modelConnections = {
    all() {
      return db.prepare('SELECT * FROM model_provider_connections').all().map((r) => rowToModelConn(r as ModelConnRow));
    },
    get(providerId: string) {
      const r = db.prepare('SELECT * FROM model_provider_connections WHERE provider_id = ?').get(providerId) as ModelConnRow | undefined;
      return r ? rowToModelConn(r) : null;
    },
    /** Create/patch connection metadata. Never touches secrets. */
    upsert(providerId: string, patch: { displayName?: string; enabled?: boolean; baseUrl?: string | null }) {
      const now = new Date().toISOString();
      const cur = this.get(providerId);
      if (!cur) {
        db.prepare(
          'INSERT INTO model_provider_connections (provider_id, display_name, enabled, base_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(providerId, patch.displayName ?? '', patch.enabled === false ? 0 : 1, patch.baseUrl ?? null, now, now);
      } else {
        db.prepare('UPDATE model_provider_connections SET display_name = ?, enabled = ?, base_url = ?, updated_at = ? WHERE provider_id = ?').run(
          patch.displayName ?? cur.displayName,
          (patch.enabled ?? cur.enabled) ? 1 : 0,
          patch.baseUrl !== undefined ? patch.baseUrl : cur.baseUrl,
          now,
          providerId,
        );
      }
      return this.get(providerId)!;
    },
    recordCheck(providerId: string, result: { ok: boolean; error?: string | null }) {
      const now = new Date().toISOString();
      // ensure a row exists
      if (!this.get(providerId)) this.upsert(providerId, {});
      db.prepare(
        'UPDATE model_provider_connections SET last_check_at = ?, last_success_at = COALESCE(?, last_success_at), last_error = ?, updated_at = ? WHERE provider_id = ?',
      ).run(now, result.ok ? now : null, result.ok ? null : (result.error ?? 'error').slice(0, 500), now, providerId);
      return this.get(providerId)!;
    },
    remove(providerId: string) {
      db.prepare('DELETE FROM model_provider_connections WHERE provider_id = ?').run(providerId);
    },
  };

  // ── Workflow run history (Phase C). Definition stays immutable; this is exec.
  const parseJson = <T,>(s: string | null, fallback: T): T => {
    if (s == null) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };
  type FlowRunRow = {
    id: string;
    workflow_id: string;
    workflow_version: number;
    status: string;
    starting_input: string;
    current_node_id: string | null;
    started_at: string | null;
    ended_at: string | null;
    error_code: string | null;
    error_message: string | null;
    total_tokens: number | null;
    estimated_cost: number | null;
    created_at: string;
    updated_at: string;
  };
  const rowToFlowRun = (r: FlowRunRow): FlowRun => ({
    id: r.id,
    workflowId: r.workflow_id,
    workflowVersion: r.workflow_version,
    status: r.status as RunStatus,
    startingInput: parseJson<StartRunInput>(r.starting_input, { text: '' }),
    currentNodeId: r.current_node_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    totalTokens: r.total_tokens,
    estimatedCost: r.estimated_cost,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const flowRuns = {
    create(input: { id: string; workflowId: string; workflowVersion: number; startingInput: StartRunInput }): FlowRun {
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO flow_runs (id, workflow_id, workflow_version, status, starting_input, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(input.id, input.workflowId, input.workflowVersion, 'queued', JSON.stringify(input.startingInput), now, now);
      return this.get(input.id)!;
    },
    get(id: string): FlowRun | null {
      const r = db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(id) as FlowRunRow | undefined;
      return r ? rowToFlowRun(r) : null;
    },
    recentForWorkflow(workflowId: string, limit = 20): FlowRun[] {
      return db
        .prepare('SELECT * FROM flow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(workflowId, limit)
        .map((r) => rowToFlowRun(r as FlowRunRow));
    },
    update(id: string, patch: Partial<Pick<FlowRun, 'status' | 'currentNodeId' | 'startedAt' | 'endedAt' | 'errorCode' | 'errorMessage' | 'totalTokens' | 'estimatedCost'>>): FlowRun | null {
      const cur = this.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare(
        'UPDATE flow_runs SET status=?, current_node_id=?, started_at=?, ended_at=?, error_code=?, error_message=?, total_tokens=?, estimated_cost=?, updated_at=? WHERE id=?',
      ).run(
        next.status,
        next.currentNodeId,
        next.startedAt,
        next.endedAt,
        next.errorCode,
        next.errorMessage,
        next.totalTokens,
        next.estimatedCost,
        new Date().toISOString(),
        id,
      );
      return this.get(id);
    },
  };

  type FlowNodeRunRow = {
    id: string;
    run_id: string;
    node_id: string;
    node_type: string;
    status: string;
    input_json: string | null;
    output_json: string | null;
    provider_id: string | null;
    model_id: string | null;
    model_strategy: string | null;
    adapter: string | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    estimated_cost: number | null;
    started_at: string | null;
    ended_at: string | null;
    duration_ms: number | null;
    attempt: number;
    error_code: string | null;
    error_message: string | null;
    created_at: string;
    updated_at: string;
  };
  const rowToNodeRun = (r: FlowNodeRunRow): FlowNodeRun => ({
    id: r.id,
    runId: r.run_id,
    nodeId: r.node_id,
    nodeType: r.node_type,
    status: r.status as NodeRunStatus,
    input: parseJson<unknown>(r.input_json, null),
    output: parseJson<NodeOutput | null>(r.output_json, null),
    providerId: r.provider_id,
    modelId: r.model_id,
    modelStrategy: r.model_strategy,
    adapter: r.adapter,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    estimatedCost: r.estimated_cost,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    attempt: r.attempt,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const flowNodeRuns = {
    create(input: { id: string; runId: string; nodeId: string; nodeType: string; status: NodeRunStatus }): FlowNodeRun {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO flow_node_runs (id, run_id, node_id, node_type, status, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(
        input.id,
        input.runId,
        input.nodeId,
        input.nodeType,
        input.status,
        now,
        now,
      );
      return this.get(input.id)!;
    },
    get(id: string): FlowNodeRun | null {
      const r = db.prepare('SELECT * FROM flow_node_runs WHERE id = ?').get(id) as FlowNodeRunRow | undefined;
      return r ? rowToNodeRun(r) : null;
    },
    forRun(runId: string): FlowNodeRun[] {
      return db.prepare('SELECT * FROM flow_node_runs WHERE run_id = ? ORDER BY created_at').all(runId).map((r) => rowToNodeRun(r as FlowNodeRunRow));
    },
    update(
      id: string,
      patch: Partial<
        Pick<
          FlowNodeRun,
          | 'status'
          | 'input'
          | 'output'
          | 'providerId'
          | 'modelId'
          | 'modelStrategy'
          | 'adapter'
          | 'promptTokens'
          | 'completionTokens'
          | 'totalTokens'
          | 'estimatedCost'
          | 'startedAt'
          | 'endedAt'
          | 'durationMs'
          | 'errorCode'
          | 'errorMessage'
        >
      >,
    ): FlowNodeRun | null {
      const cur = this.get(id);
      if (!cur) return null;
      const n = { ...cur, ...patch };
      db.prepare(
        `UPDATE flow_node_runs SET status=?, input_json=?, output_json=?, provider_id=?, model_id=?, model_strategy=?, adapter=?,
          prompt_tokens=?, completion_tokens=?, total_tokens=?, estimated_cost=?, started_at=?, ended_at=?, duration_ms=?,
          error_code=?, error_message=?, updated_at=? WHERE id=?`,
      ).run(
        n.status,
        n.input === null ? null : JSON.stringify(n.input),
        n.output === null ? null : JSON.stringify(n.output),
        n.providerId,
        n.modelId,
        n.modelStrategy,
        n.adapter,
        n.promptTokens,
        n.completionTokens,
        n.totalTokens,
        n.estimatedCost,
        n.startedAt,
        n.endedAt,
        n.durationMs,
        n.errorCode,
        n.errorMessage,
        new Date().toISOString(),
        id,
      );
      return this.get(id);
    },
  };

  type FlowApprovalRow = {
    id: string;
    run_id: string;
    node_run_id: string | null;
    workflow_id: string;
    workflow_version: number;
    node_id: string;
    status: string;
    request_type: string;
    title: string;
    message: string;
    context_json: string | null;
    approval_route: string;
    rejection_route: string;
    requested_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
    resolution_note: string | null;
    created_at: string;
    updated_at: string;
  };
  const rowToApproval = (r: FlowApprovalRow): FlowApproval => ({
    id: r.id,
    runId: r.run_id,
    nodeRunId: r.node_run_id,
    workflowId: r.workflow_id,
    workflowVersion: r.workflow_version,
    nodeId: r.node_id,
    status: r.status as ApprovalStatus,
    requestType: r.request_type as ApprovalRequestType,
    title: r.title,
    message: r.message,
    context: parseJson<unknown>(r.context_json, null),
    approvalRoute: r.approval_route,
    rejectionRoute: r.rejection_route,
    requestedAt: r.requested_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  // Human Approval gates (Phase E). `resolve` is a CONDITIONAL update (only a
  // `pending` row transitions) so approving twice runs the workflow exactly once
  // (idempotency lives in SQLite, not the caller). context is NON-SECRET only.
  const flowApprovals = {
    create(input: {
      id: string;
      runId: string;
      nodeRunId: string | null;
      workflowId: string;
      workflowVersion: number;
      nodeId: string;
      requestType?: ApprovalRequestType;
      title: string;
      message: string;
      context?: unknown;
      approvalRoute: string;
      rejectionRoute: string;
    }): FlowApproval {
      const nowIso = new Date().toISOString();
      db.prepare(
        `INSERT INTO flow_approvals
          (id, run_id, node_run_id, workflow_id, workflow_version, node_id, status, request_type,
           title, message, context_json, approval_route, rejection_route, requested_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.runId,
        input.nodeRunId,
        input.workflowId,
        input.workflowVersion,
        input.nodeId,
        input.requestType ?? 'workflow',
        input.title,
        input.message,
        input.context === undefined ? null : JSON.stringify(input.context),
        input.approvalRoute,
        input.rejectionRoute,
        nowIso,
        nowIso,
        nowIso,
      );
      return this.get(input.id)!;
    },
    get(id: string): FlowApproval | null {
      const r = db.prepare('SELECT * FROM flow_approvals WHERE id = ?').get(id) as FlowApprovalRow | undefined;
      return r ? rowToApproval(r) : null;
    },
    forRun(runId: string): FlowApproval[] {
      return db
        .prepare('SELECT * FROM flow_approvals WHERE run_id = ? ORDER BY created_at')
        .all(runId)
        .map((r) => rowToApproval(r as FlowApprovalRow));
    },
    /** The most recent approval attached to a specific node run (for resume). */
    latestForNodeRun(nodeRunId: string): FlowApproval | null {
      const r = db
        .prepare('SELECT * FROM flow_approvals WHERE node_run_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(nodeRunId) as FlowApprovalRow | undefined;
      return r ? rowToApproval(r) : null;
    },
    /** All pending approvals across runs, newest first — the Approvals inbox. */
    pending(limit = 100): FlowApproval[] {
      return db
        .prepare("SELECT * FROM flow_approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?")
        .all(limit)
        .map((r) => rowToApproval(r as FlowApprovalRow));
    },
    /**
     * Conditionally resolve a PENDING approval. Returns the row only when THIS
     * call performed the transition (SQLite `changes === 1`); a second concurrent
     * approve sees `changes === 0` and gets `null` (idempotent — one execution).
     */
    resolve(id: string, decision: 'approved' | 'rejected', resolvedBy: string, note: string | null): FlowApproval | null {
      const nowIso = new Date().toISOString();
      const res = db
        .prepare(
          "UPDATE flow_approvals SET status = ?, resolved_at = ?, resolved_by = ?, resolution_note = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(decision, nowIso, resolvedBy, note, nowIso, id);
      if (res.changes !== 1) return null;
      return this.get(id);
    },
    /** Cancel every still-pending approval for a run (used when a run is canceled). */
    cancelForRun(runId: string, resolvedBy: string): number {
      const nowIso = new Date().toISOString();
      const res = db
        .prepare(
          "UPDATE flow_approvals SET status = 'cancelled', resolved_at = ?, resolved_by = ?, updated_at = ? WHERE run_id = ? AND status = 'pending'",
        )
        .run(nowIso, resolvedBy, nowIso, runId);
      return res.changes;
    },
  };

  // One-time, idempotent import of the legacy `agent_flows` "main" canvas into a
  // real workflow (id `wf-main`). Preserves node positions, agent references,
  // edges, and the flow name. The old table is left untouched (backward compat).
  const flowMaintenance = {
    importMainFlow(): { imported: boolean } {
      if (flowWorkflows.get('wf-main')) return { imported: false }; // already imported — idempotent
      const main = db.prepare("SELECT name, nodes, edges FROM agent_flows WHERE id = 'main'").get() as
        | { name: string; nodes: string; edges: string }
        | undefined;
      if (!main) return { imported: false };
      let nodesRaw: { id: string; agentId: string; x: number; y: number }[] = [];
      let edgesRaw: { id: string; source: string; target: string }[] = [];
      try {
        nodesRaw = JSON.parse(main.nodes);
        edgesRaw = JSON.parse(main.edges);
      } catch {
        return { imported: false }; // malformed legacy data — never crash DB open
      }
      const graph: WorkflowGraph = {
        nodes: nodesRaw.map((n) => ({ id: n.id, type: 'agent', x: n.x, y: n.y, config: { agentId: n.agentId } })),
        edges: edgesRaw.map((e) => ({ id: e.id, source: e.source, target: e.target, mapping: { mode: 'all' as const } })),
        metadata: { importedFrom: 'agent_flows:main' },
      };
      flowWorkflows.create({
        id: 'wf-main',
        name: main.name || 'Agent Flow',
        description: 'Imported from the original Agent Flow canvas.',
        graph,
      });
      flowVersions.create({ id: 'wf-main-v1', workflowId: 'wf-main', version: 1, graph });
      flowWorkflows.setCurrentVersion('wf-main', 1);
      return { imported: true };
    },
  };

  // Workspace reset. Both routines deliberately leave the structural scaffolding
  // (departments, the built-in agent roster, tools) AND every client-created
  // custom agent intact, so the OS keeps working — it just empties out.
  const maintenance = {
    // Wipe accumulated operational logs: runs, chats, broadcasts, tasks, crons,
    // inbound DMs, contact tags, queued posts. Reference/content tables untouched.
    clearActivity(): void {
      for (const t of [
        'broadcast_replies',
        'broadcasts',
        'agent_runs',
        'agent_messages',
        'agent_tasks',
        'agent_crons',
        'social_dm_messages',
        'contact_tags',
        'social_posts',
      ]) {
        db.prepare(`DELETE FROM ${t}`).run();
      }
    },
    // A full "start clean": activity + ALL seeded demo content — the funnel,
    // social presence, email list, every fabricated business artifact
    // (personas, roadmap, workflows, skills, metrics, reference domains, org
    // SOPs, people), AND the seeded agent roster + tool catalog (named after
    // one specific business). Sets `demo_cleared` so a re-seed never brings it
    // back. The client fills the blank roster with their own custom agents.
    //
    // What survives is only the neutral scaffolding: the departments (a generic
    // org structure) and every client-created custom agent.
    clearDemoContent(): void {
      this.clearActivity();
      for (const t of [
        // demo business data
        'funnel_touches',
        'funnel_contacts',
        'social_snapshots',
        'social_dm_snapshots',
        'social_dms',
        'social_accounts',
        'email_list_snapshots',
        // fabricated content that made the app look like one specific business
        'personas',
        'roadmap_items',
        'workflows',
        'skills',
        'metrics',
        'domains',
        'phases',
        'sop_tasks',
        'people',
        // the seeded roster + tool catalog carry business-specific names, so a
        // blank slate clears them too — custom_agents (the client's own) stay.
        'agents',
        'tools',
      ]) {
        db.prepare(`DELETE FROM ${t}`).run();
      }
      meta.set('demo_cleared', '1');
    },
  };

  const tools = {
    all(): Tool[] {
      return db
        .prepare('SELECT * FROM tools ORDER BY category, name')
        .all()
        .map((r) => ToolSchema.parse(r));
    },
    insert(t: Tool): void {
      db.prepare(
        'INSERT OR REPLACE INTO tools (id, name, category, status, color, description) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(t.id, t.name, t.category, t.status, t.color, t.description);
    },
  };

  const roadmap = {
    all(): RoadmapItem[] {
      return db
        .prepare('SELECT * FROM roadmap_items ORDER BY quarter, title')
        .all()
        .map((r: any) =>
          RoadmapItemSchema.parse({
            id: r.id,
            title: r.title,
            quarter: r.quarter,
            status: r.status,
            departmentId: r.department_id,
            description: r.description,
          }),
        );
    },
    insert(item: RoadmapItem): void {
      db.prepare(
        'INSERT OR REPLACE INTO roadmap_items (id, title, quarter, status, department_id, description) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(item.id, item.title, item.quarter, item.status, item.departmentId, item.description);
    },
  };

  const metrics = {
    all(): Metric[] {
      return db
        .prepare('SELECT * FROM metrics ORDER BY label')
        .all()
        .map((r) => MetricSchema.parse(r));
    },
    insert(m: Metric): void {
      db.prepare(
        'INSERT OR REPLACE INTO metrics (id, key, label, value, unit, delta, period) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(m.id, m.key, m.label, m.value, m.unit, m.delta, m.period);
    },
  };

  const domains = {
    all(): Domain[] {
      return db
        .prepare('SELECT * FROM domains ORDER BY number')
        .all()
        .map((r: any) => DomainSchema.parse({ ...r, items: JSON.parse(r.items) }));
    },
    insert(d: Domain): void {
      db.prepare('INSERT OR REPLACE INTO domains (id, number, title, color, items) VALUES (?, ?, ?, ?, ?)').run(
        d.id,
        d.number,
        d.title,
        d.color,
        JSON.stringify(d.items),
      );
    },
  };

  const personas = {
    all(): Persona[] {
      return db
        .prepare('SELECT * FROM personas ORDER BY ord')
        .all()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((r: any) =>
          PersonaSchema.parse({
            id: r.id,
            order: r.ord,
            name: r.name,
            archetype: r.archetype,
            tagline: r.tagline,
            summary: r.summary,
            accent: r.accent,
            northStar: r.north_star,
            pillars: JSON.parse(r.pillars),
            connectors: JSON.parse(r.connectors),
            metrics: JSON.parse(r.metrics),
            brainUse: r.brain_use,
            signaturePlay: r.signature_play,
          }),
        );
    },
    insert(p: Persona): void {
      db.prepare(
        `INSERT OR REPLACE INTO personas
          (id, ord, name, archetype, tagline, summary, accent, north_star, pillars, connectors, metrics, brain_use, signature_play)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        p.id,
        p.order,
        p.name,
        p.archetype,
        p.tagline,
        p.summary,
        p.accent,
        p.northStar,
        JSON.stringify(p.pillars),
        JSON.stringify(p.connectors),
        JSON.stringify(p.metrics),
        p.brainUse,
        p.signaturePlay,
      );
    },
  };

  const phases = {
    all(): Phase[] {
      return db
        .prepare('SELECT * FROM phases ORDER BY number')
        .all()
        .map((r: any) => PhaseSchema.parse({ ...r, items: JSON.parse(r.items) }));
    },
    insert(p: Phase): void {
      db.prepare('INSERT OR REPLACE INTO phases (id, number, title, items) VALUES (?, ?, ?, ?)').run(
        p.id,
        p.number,
        p.title,
        JSON.stringify(p.items),
      );
    },
  };

  const rowToRun = (r: any): AgentRun =>
    AgentRunSchema.parse({
      id: r.id,
      agentId: r.agent_id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      ok: Boolean(r.ok),
      summary: r.summary,
      model: r.model ?? null,
      tokensIn: r.tokens_in ?? null,
      tokensOut: r.tokens_out ?? null,
      costUsd: r.cost_usd ?? null,
    });

  const agentRuns = {
    byAgent(agentId: string): AgentRun[] {
      return db
        .prepare('SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC')
        .all(agentId)
        .map(rowToRun);
    },
    recent(limit: number): AgentRun[] {
      return db
        .prepare('SELECT * FROM agent_runs ORDER BY started_at DESC, rowid DESC LIMIT ?')
        .all(limit)
        .map(rowToRun);
    },
    insert(run: AgentRun): void {
      db.prepare(
        'INSERT OR REPLACE INTO agent_runs (id, agent_id, started_at, finished_at, ok, summary, model, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        run.id, run.agentId, run.startedAt, run.finishedAt, run.ok ? 1 : 0, run.summary,
        run.model ?? null, run.tokensIn ?? null, run.tokensOut ?? null, run.costUsd ?? null,
      );
    },
  };

  const rowToMessage = (r: any): AgentMessage =>
    AgentMessageSchema.parse({
      id: r.id,
      agentId: r.agent_id,
      role: r.role,
      content: r.content,
      toolCalls: JSON.parse(r.tool_calls || '[]'),
      createdAt: r.created_at,
    });

  const agentMessages = {
    insert(m: AgentMessage): void {
      const parsed = AgentMessageSchema.parse(m);
      db.prepare(
        'INSERT OR REPLACE INTO agent_messages (id, agent_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(parsed.id, parsed.agentId, parsed.role, parsed.content, JSON.stringify(parsed.toolCalls), parsed.createdAt);
    },
    /** Full conversation for one agent, oldest → newest (ready to replay). */
    byAgent(agentId: string): AgentMessage[] {
      return db
        .prepare('SELECT * FROM agent_messages WHERE agent_id = ? ORDER BY created_at ASC, rowid ASC')
        .all(agentId)
        .map(rowToMessage);
    },
    recent(limit: number): AgentMessage[] {
      return db
        .prepare('SELECT * FROM agent_messages ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(limit)
        .map(rowToMessage);
    },
  };

  const rowToReply = (r: any): BroadcastReply =>
    BroadcastReplySchema.parse({
      id: r.id,
      broadcastId: r.broadcast_id,
      agentId: r.agent_id,
      ok: Boolean(r.ok),
      reply: r.reply,
      finishedAt: r.finished_at,
    });

  const broadcasts = {
    insert(b: { id: string; message: string; createdAt: string }): void {
      db.prepare('INSERT OR REPLACE INTO broadcasts (id, message, created_at) VALUES (?, ?, ?)').run(
        b.id, b.message, b.createdAt,
      );
    },
    insertReply(r: BroadcastReply): void {
      db.prepare(
        'INSERT OR REPLACE INTO broadcast_replies (id, broadcast_id, agent_id, ok, reply, finished_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(r.id, r.broadcastId, r.agentId, r.ok ? 1 : 0, r.reply, r.finishedAt);
    },
    recent(limit: number): Broadcast[] {
      const rows = db
        .prepare('SELECT * FROM broadcasts ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(limit) as { id: string; message: string; created_at: string }[];
      const replyStmt = db.prepare('SELECT * FROM broadcast_replies WHERE broadcast_id = ? ORDER BY agent_id');
      return rows.map((b) =>
        BroadcastSchema.parse({
          id: b.id,
          message: b.message,
          createdAt: b.created_at,
          replies: replyStmt.all(b.id).map(rowToReply),
        }),
      );
    },
  };

  const rowToTask = (r: any): AgentTask =>
    AgentTaskSchema.parse({
      id: r.id, agentId: r.agent_id, title: r.title, status: r.status,
      createdAt: r.created_at, updatedAt: r.updated_at,
    });

  const agentTasks = {
    insert(t: AgentTask): void {
      AgentTaskSchema.parse(t);
      db.prepare(
        'INSERT OR REPLACE INTO agent_tasks (id, agent_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(t.id, t.agentId, t.title, t.status, t.createdAt, t.updatedAt);
    },
    byAgent(agentId: string): AgentTask[] {
      return db
        .prepare('SELECT * FROM agent_tasks WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC')
        .all(agentId)
        .map(rowToTask);
    },
    all(): AgentTask[] {
      return db.prepare('SELECT * FROM agent_tasks ORDER BY created_at DESC, rowid DESC').all().map(rowToTask);
    },
    setStatus(id: string, status: AgentTask['status'], updatedAt: string): void {
      AgentTaskSchema.shape.status.parse(status);
      db.prepare('UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, updatedAt, id);
    },
    remove(id: string): void {
      db.prepare('DELETE FROM agent_tasks WHERE id = ?').run(id);
    },
  };

  const rowToCron = (r: any): AgentCron =>
    AgentCronSchema.parse({
      id: r.id, agentId: r.agent_id, schedule: r.schedule, description: r.description,
      enabled: Boolean(r.enabled), createdAt: r.created_at,
    });

  const agentCrons = {
    insert(c: AgentCron): void {
      AgentCronSchema.parse(c);
      if (!isValidCron(c.schedule)) throw new Error(`invalid cron schedule: ${c.schedule}`);
      db.prepare(
        'INSERT OR REPLACE INTO agent_crons (id, agent_id, schedule, description, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(c.id, c.agentId, c.schedule, c.description, c.enabled ? 1 : 0, c.createdAt);
    },
    byAgent(agentId: string): AgentCron[] {
      return db
        .prepare('SELECT * FROM agent_crons WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC')
        .all(agentId)
        .map(rowToCron);
    },
    all(): AgentCron[] {
      return db.prepare('SELECT * FROM agent_crons ORDER BY created_at DESC, rowid DESC').all().map(rowToCron);
    },
    setEnabled(id: string, enabled: boolean): void {
      db.prepare('UPDATE agent_crons SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    },
    remove(id: string): void {
      db.prepare('DELETE FROM agent_crons WHERE id = ?').run(id);
    },
  };

  const contactTags = {
    upsert(t: ContactTag): void {
      ContactTagSchema.parse(t);
      db.prepare(
        'INSERT INTO contact_tags (person, channel, tag, tier) VALUES (?, ?, ?, ?) ON CONFLICT(person, channel) DO UPDATE SET tag = excluded.tag, tier = excluded.tier',
      ).run(t.person, t.channel, t.tag, t.tier);
    },
    all(): ContactTag[] {
      return (db.prepare('SELECT * FROM contact_tags ORDER BY tier, person').all() as ContactTag[]).map(
        (r) => ContactTagSchema.parse(r),
      );
    },
    byTier(tier: number): ContactTag[] {
      return (
        db.prepare('SELECT * FROM contact_tags WHERE tier = ? ORDER BY person').all(tier) as ContactTag[]
      ).map((r) => ContactTagSchema.parse(r));
    },
    remove(person: string, channel: string): void {
      db.prepare('DELETE FROM contact_tags WHERE person = ? AND channel = ?').run(person, channel);
    },
  };

  const rowToSnapshot = (r: any): SocialSnapshot =>
    SocialSnapshotSchema.parse({
      platform: r.platform,
      capturedAt: r.captured_at,
      followers: r.followers,
      source: r.source,
    });

  const social = {
    upsertAccount(a: SocialAccount): void {
      SocialAccountSchema.parse(a);
      db.prepare(
        'INSERT OR REPLACE INTO social_accounts (platform, handle, url, "order") VALUES (?, ?, ?, ?)',
      ).run(a.platform, a.handle, a.url, a.order);
    },
    accounts(): SocialAccount[] {
      return db
        .prepare('SELECT * FROM social_accounts ORDER BY "order"')
        .all()
        .map((r) => SocialAccountSchema.parse(r));
    },
    insertSnapshot(s: SocialSnapshot): void {
      SocialSnapshotSchema.parse(s);
      db.prepare(
        'INSERT OR REPLACE INTO social_snapshots (platform, captured_at, followers, source) VALUES (?, ?, ?, ?)',
      ).run(s.platform, s.capturedAt, s.followers, s.source);
    },
    snapshots(platform: SocialPlatform): SocialSnapshot[] {
      return db
        .prepare('SELECT * FROM social_snapshots WHERE platform = ? ORDER BY captured_at')
        .all(platform)
        .map(rowToSnapshot);
    },
    latest(): SocialSnapshot[] {
      return db
        .prepare(
          `SELECT * FROM social_snapshots s
           WHERE captured_at = (SELECT MAX(captured_at) FROM social_snapshots WHERE platform = s.platform)
           ORDER BY platform`,
        )
        .all()
        .map(rowToSnapshot);
    },
    upsertDm(d: SocialDm): void {
      SocialDmSchema.parse(d);
      db.prepare(
        'INSERT OR REPLACE INTO social_dms (platform, count, updated_at) VALUES (?, ?, ?)',
      ).run(d.platform, d.count, d.updatedAt);
    },
    dms(): SocialDm[] {
      return db
        .prepare(
          `SELECT d.platform, d.count, d.updated_at AS updatedAt FROM social_dms d
           LEFT JOIN social_accounts a ON a.platform = d.platform
           ORDER BY a."order"`,
        )
        .all()
        .map((r) => SocialDmSchema.parse(r));
    },
    insertDmSnapshot(s: SocialDmSnapshot): void {
      SocialDmSnapshotSchema.parse(s);
      db.prepare(
        'INSERT OR REPLACE INTO social_dm_snapshots (platform, captured_at, count, source) VALUES (?, ?, ?, ?)',
      ).run(s.platform, s.capturedAt, s.count, s.source);
    },
    dmSnapshots(platform?: SocialPlatform): SocialDmSnapshot[] {
      const rows = platform
        ? db
            .prepare('SELECT platform, captured_at AS capturedAt, count, source FROM social_dm_snapshots WHERE platform = ? ORDER BY captured_at')
            .all(platform)
        : db
            .prepare('SELECT platform, captured_at AS capturedAt, count, source FROM social_dm_snapshots ORDER BY platform, captured_at')
            .all();
      return rows.map((r) => SocialDmSnapshotSchema.parse(r));
    },
    // Individual DM messages (the inbox). Fed live by POST /api/webhooks/manychat;
    // seeded until then. Upsert by id so replayed webhooks don't duplicate.
    upsertDmMessage(m: SocialDmMessage): void {
      SocialDmMessageSchema.parse(m);
      db.prepare(
        `INSERT OR REPLACE INTO social_dm_messages
           (id, platform, subscriber_id, name, handle, text, direction, tag, ts, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(m.id, m.platform, m.subscriberId, m.name, m.handle, m.text, m.direction, m.tag, m.ts, m.source);
    },
    dmMessages(platform?: SocialPlatform): SocialDmMessage[] {
      const cols =
        'id, platform, subscriber_id AS subscriberId, name, handle, text, direction, tag, ts, source';
      const rows = platform
        ? db.prepare(`SELECT ${cols} FROM social_dm_messages WHERE platform = ? ORDER BY ts DESC`).all(platform)
        : db.prepare(`SELECT ${cols} FROM social_dm_messages ORDER BY ts DESC`).all();
      return rows.map((r) => SocialDmMessageSchema.parse(r));
    },
  };

  const emailList = {
    insertSnapshot(s: EmailListSnapshot): void {
      EmailListSnapshotSchema.parse(s);
      db.prepare(
        'INSERT OR REPLACE INTO email_list_snapshots (captured_at, subscribers, source) VALUES (?, ?, ?)',
      ).run(s.capturedAt, s.subscribers, s.source);
    },
    // Drop seed-sourced rows so a re-seed is authoritative — the real Beehiiv
    // baseline replaces any retired dummy history. Live-synced snapshots
    // (source 'beehiiv') are preserved.
    deleteSeeded(): void {
      db.prepare("DELETE FROM email_list_snapshots WHERE source LIKE 'seed%'").run();
    },
    snapshots(): EmailListSnapshot[] {
      return db
        .prepare('SELECT captured_at AS capturedAt, subscribers, source FROM email_list_snapshots ORDER BY captured_at')
        .all()
        .map((r) => EmailListSnapshotSchema.parse(r));
    },
    latest(): EmailListSnapshot | null {
      const row = db
        .prepare('SELECT captured_at AS capturedAt, subscribers, source FROM email_list_snapshots ORDER BY captured_at DESC LIMIT 1')
        .get();
      return row ? EmailListSnapshotSchema.parse(row) : null;
    },
  };

  const rowToPost = (r: {
    id: string;
    caption: string;
    media_url: string | null;
    platforms: string;
    status: string;
    scheduled_for: string | null;
    created_at: string;
  }): SocialPost =>
    SocialPostSchema.parse({
      id: r.id,
      caption: r.caption,
      mediaUrl: r.media_url,
      platforms: JSON.parse(r.platforms),
      status: r.status,
      scheduledFor: r.scheduled_for,
      createdAt: r.created_at,
    });

  const socialPosts = {
    enqueue(p: SocialPost): void {
      SocialPostSchema.parse(p);
      db.prepare(
        `INSERT OR REPLACE INTO social_posts (id, caption, media_url, platforms, status, scheduled_for, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(p.id, p.caption, p.mediaUrl, JSON.stringify(p.platforms), p.status, p.scheduledFor, p.createdAt);
    },
    all(): SocialPost[] {
      return db
        .prepare('SELECT * FROM social_posts ORDER BY created_at DESC')
        .all()
        .map((r) => rowToPost(r as Parameters<typeof rowToPost>[0]));
    },
    queued(): SocialPost[] {
      return db
        .prepare("SELECT * FROM social_posts WHERE status = 'queued' ORDER BY created_at DESC")
        .all()
        .map((r) => rowToPost(r as Parameters<typeof rowToPost>[0]));
    },
  };

  const people = {
    all(): Person[] {
      return db
        .prepare('SELECT * FROM people ORDER BY department_id, name')
        .all()
        .map((r: any) =>
          PersonSchema.parse({
            id: r.id,
            departmentId: r.department_id,
            name: r.name,
            role: r.role,
            tools: JSON.parse(r.tools),
          }),
        );
    },
    insert(p: Person): void {
      PersonSchema.parse(p);
      db.prepare(
        'INSERT OR REPLACE INTO people (id, department_id, name, role, tools) VALUES (?, ?, ?, ?, ?)',
      ).run(p.id, p.departmentId, p.name, p.role, JSON.stringify(p.tools));
    },
    deleteWhereIdNotIn(ids: string[]): void {
      const placeholders = ids.map(() => '?').join(', ');
      db.prepare(`DELETE FROM people WHERE id NOT IN (${placeholders})`).run(...ids);
    },
  };

  const sopTasks = {
    all(): SopTask[] {
      return db
        .prepare('SELECT * FROM sop_tasks ORDER BY department_id, title')
        .all()
        .map((r: any) =>
          SopTaskSchema.parse({
            id: r.id,
            departmentId: r.department_id,
            title: r.title,
            summary: r.summary,
            steps: JSON.parse(r.steps),
            assigneeKind: r.assignee_kind,
            assigneeId: r.assignee_id,
          }),
        );
    },
    insert(t: SopTask): void {
      SopTaskSchema.parse(t);
      db.prepare(
        'INSERT OR REPLACE INTO sop_tasks (id, department_id, title, summary, steps, assignee_kind, assignee_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(t.id, t.departmentId, t.title, t.summary, JSON.stringify(t.steps), t.assigneeKind, t.assigneeId);
    },
    deleteWhereIdNotIn(ids: string[]): void {
      const placeholders = ids.map(() => '?').join(', ');
      db.prepare(`DELETE FROM sop_tasks WHERE id NOT IN (${placeholders})`).run(...ids);
    },
  };

  const workflows = {
    all(): Workflow[] {
      return db
        .prepare('SELECT * FROM workflows ORDER BY ord, name')
        .all()
        .map((r: any) =>
          WorkflowSchema.parse({
            id: r.id,
            name: r.name,
            subtitle: r.subtitle,
            revenueUsd: r.revenue_usd,
            order: r.ord,
            steps: JSON.parse(r.steps),
          }),
        );
    },
    get(id: string): Workflow | null {
      const r = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as any;
      return r
        ? WorkflowSchema.parse({
            id: r.id,
            name: r.name,
            subtitle: r.subtitle,
            revenueUsd: r.revenue_usd,
            order: r.ord,
            steps: JSON.parse(r.steps),
          })
        : null;
    },
    /** Highest current order, or -1 when empty — callers append at maxOrder + 1. */
    maxOrder(): number {
      const r = db.prepare('SELECT MAX(ord) AS m FROM workflows').get() as { m: number | null };
      return r.m ?? -1;
    },
    insert(w: Workflow): void {
      WorkflowSchema.parse(w);
      db.prepare(
        'INSERT OR REPLACE INTO workflows (id, name, subtitle, revenue_usd, ord, steps) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(w.id, w.name, w.subtitle, w.revenueUsd, w.order, JSON.stringify(w.steps));
    },
    remove(id: string): void {
      db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    },
    deleteWhereIdNotIn(ids: string[]): void {
      const placeholders = ids.map(() => '?').join(', ');
      db.prepare(`DELETE FROM workflows WHERE id NOT IN (${placeholders})`).run(...ids);
    },
  };

  const skills = {
    all(): Skill[] {
      return db
        .prepare('SELECT * FROM skills ORDER BY ord, name')
        .all()
        .map((r: any) =>
          SkillSchema.parse({
            id: r.id,
            name: r.name,
            category: r.category,
            description: r.description,
            ownerAgentId: r.owner_agent_id,
            status: r.status,
            tools: JSON.parse(r.tools),
            markdown: r.markdown,
            order: r.ord,
          }),
        );
    },
    insert(s: Skill): void {
      SkillSchema.parse(s);
      db.prepare(
        'INSERT OR REPLACE INTO skills (id, name, category, description, owner_agent_id, status, tools, markdown, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(s.id, s.name, s.category, s.description, s.ownerAgentId, s.status, JSON.stringify(s.tools), s.markdown, s.order);
    },
    deleteWhereIdNotIn(ids: string[]): void {
      const placeholders = ids.map(() => '?').join(', ');
      db.prepare(`DELETE FROM skills WHERE id NOT IN (${placeholders})`).run(...ids);
    },
  };

  const rowToFunnelTouch = (r: any): FunnelTouch =>
    FunnelTouchSchema.parse({
      id: r.id,
      contactId: r.contact_id,
      seq: r.seq,
      stage: r.stage,
      channel: r.channel,
      label: r.label,
      source: r.source,
      at: r.at,
    });

  const funnel = {
    insertContact(c: FunnelContact): void {
      FunnelContactSchema.parse(c);
      db.prepare(
        'INSERT OR REPLACE INTO funnel_contacts (id, name, venture, status, product, amount_usd, relationship, likelihood, email, phone, person, company, role, linkedin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(c.id, c.name, c.venture, c.status, c.product, c.amountUsd, c.relationship, c.likelihood, c.email, c.phone, c.person, c.company, c.role, c.linkedin, c.createdAt);
    },
    insertTouch(t: FunnelTouch): void {
      FunnelTouchSchema.parse(t);
      db.prepare(
        'INSERT OR REPLACE INTO funnel_touches (id, contact_id, seq, stage, channel, label, source, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(t.id, t.contactId, t.seq, t.stage, t.channel, t.label, t.source, t.at);
    },
    /** Contacts with their touches in journey order, newest contact first. */
    journeys(venture?: FunnelVenture): FunnelJourney[] {
      const rows = (
        venture
          ? db.prepare('SELECT * FROM funnel_contacts WHERE venture = ? ORDER BY created_at DESC, id').all(venture)
          : db.prepare('SELECT * FROM funnel_contacts ORDER BY created_at DESC, id').all()
      ) as any[];
      const touchStmt = db.prepare('SELECT * FROM funnel_touches WHERE contact_id = ? ORDER BY seq');
      return rows.map((r) =>
        FunnelJourneySchema.parse({
          id: r.id,
          name: r.name,
          venture: r.venture,
          status: r.status,
          product: r.product,
          amountUsd: r.amount_usd,
          relationship: r.relationship,
          likelihood: r.likelihood,
          email: r.email,
          phone: r.phone,
          person: r.person,
          company: r.company,
          role: r.role,
          linkedin: r.linkedin,
          createdAt: r.created_at,
          touches: touchStmt.all(r.id).map(rowToFunnelTouch),
        }),
      );
    },
  };

  // Bring the legacy "main" canvas into the new workflow system on first open.
  // Idempotent (keyed on the `wf-main` id) and best-effort — never blocks DB open.
  try {
    flowMaintenance.importMainFlow();
  } catch {
    /* legacy import is best-effort */
  }

  return {
    departments,
    agents,
    customAgents,
    agentFlows,
    flowWorkflows,
    flowVersions,
    flowMaintenance,
    flowRuns,
    flowNodeRuns,
    flowApprovals,
    modelConnections,
    meta,
    maintenance,
    tools,
    roadmap,
    metrics,
    domains,
    personas,
    phases,
    agentRuns,
    agentMessages,
    agentTasks,
    agentCrons,
    broadcasts,
    contactTags,
    social,
    emailList,
    socialPosts,
    funnel,
    people,
    sopTasks,
    workflows,
    skills,
    close: () => db.close(),
  };
}

export type FounderDb = ReturnType<typeof openDb>;
