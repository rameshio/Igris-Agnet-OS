import Database from 'better-sqlite3';
import { isValidCron } from '@/lib/cron';
import type { WorkflowGraph } from '@/lib/flows/schema';
import {
  CapabilityInputSchema,
  AgentCapabilityAssignSchema,
  domainOf,
  type Capability,
  type AgentCapability,
  type CapabilitySource,
} from '@/lib/agents/capabilities';
import type { Mission, CompanyTask, CompanyTaskDependency } from '@/lib/company/model';
import type { CompanyArtifact, CompanyEvent, CompanyEventType } from '@/lib/company/manager/model';
import { DEFAULT_FACTORY_POLICY, type AgentProposal, type AgentSpec, type FactoryPolicy, type ProposalStatus } from '@/lib/company/factory/model';
import {
  canonicalKey,
  type BrainEntity,
  type BrainEntityType,
  type BrainKnowledge,
  type BrainRelationship,
  type BrainRelationshipType,
  type BrainSource,
  type CanonicalRef,
  type CanonicalRefKind,
  type KnowledgeKind,
  type KnowledgeStatus,
  type SourceType,
} from '@/lib/brain/core/model';
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
-- Company Registry capability layer (Architecture V2 · F0.1). Additive; keyed by
-- the canonical RuntimeAgent id string (built-in OR custom-*) — NOT an FK, since
-- built-in agents are code (not rows) and custom agents live in a different table.
CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_capabilities (
  agent_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  proficiency INTEGER,
  source TEXT NOT NULL DEFAULT 'explicit',
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, capability_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_capabilities_capability ON agent_capabilities (capability_id);
-- Company work model (Architecture V2 · F0.2). Canonical Missions + Company Tasks,
-- DISTINCT from the lightweight per-agent agent_tasks kanban (untouched). Additive;
-- cross-subsystem references (agent/workflow/run/parent/mission) are validated in the
-- service layer, not by FK, to match the repo canonical-id strategy.
CREATE TABLE IF NOT EXISTS company_missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  priority TEXT NOT NULL DEFAULT 'normal',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_company_missions_status ON company_missions (status);
CREATE TABLE IF NOT EXISTS company_tasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  parent_task_id TEXT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  assigned_agent_id TEXT,
  workflow_id TEXT,
  run_id TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  required_capabilities TEXT NOT NULL DEFAULT '[]',
  execution_kind TEXT,
  execution_ref_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_failure_code TEXT,
  last_failure_class TEXT,
  last_failure_summary TEXT,
  last_failure_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_company_tasks_mission ON company_tasks (mission_id);
CREATE INDEX IF NOT EXISTS idx_company_tasks_status ON company_tasks (status);
CREATE INDEX IF NOT EXISTS idx_company_tasks_agent ON company_tasks (assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_company_tasks_parent ON company_tasks (parent_task_id);
CREATE TABLE IF NOT EXISTS company_task_dependencies (
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS idx_company_task_deps_dependson ON company_task_dependencies (depends_on_task_id);
-- Executive Manager (Architecture V2 · F1). company_artifacts = structured work
-- products (traceable to mission/task/execution). company_events = an APPEND-ONLY
-- operational ledger for real delegation — NOT canonical state (Mission/Task/
-- Artifact/Run/Agent remain the source of truth). Additive; no FK.
CREATE TABLE IF NOT EXISTS company_artifacts (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  task_id TEXT,
  produced_by_agent_id TEXT,
  workflow_run_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  content_json TEXT,
  content_type TEXT,
  source_refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_company_artifacts_mission ON company_artifacts (mission_id);
CREATE INDEX IF NOT EXISTS idx_company_artifacts_task ON company_artifacts (task_id);
CREATE TABLE IF NOT EXISTS company_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  mission_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  workflow_id TEXT,
  artifact_id TEXT,
  summary TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_company_events_mission ON company_events (mission_id, created_at);
-- Agent Factory (Architecture V2 · F2). A human-gated PROPOSAL to create a new agent
-- that fills a CAPABILITY_GAP. The row IS the pending artifact — no agent exists until
-- a human approves (promotion). Additive; cross-subsystem refs (mission/task/agent) are
-- validated in the service layer, not by FK, matching the repo canonical-id strategy.
CREATE TABLE IF NOT EXISTS company_agent_proposals (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  task_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  spec_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  required_capabilities TEXT NOT NULL DEFAULT '[]',
  rationale TEXT,
  temporary INTEGER NOT NULL DEFAULT 1,
  max_depth INTEGER NOT NULL DEFAULT 1,
  budget_usd REAL,
  agent_id TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_company_agent_proposals_mission ON company_agent_proposals (mission_id);
CREATE INDEX IF NOT EXISTS idx_company_agent_proposals_status ON company_agent_proposals (status);
-- G-Brain Core (Architecture V2 · F3). The CANONICAL, durable, in-app knowledge layer:
-- Entities + Relationships + Knowledge + Sources/provenance. DISTINCT from the external
-- gbrain markdown store and the /brain visualization graphs. Additive; G-Brain REFERENCES
-- canonical objects (agent/mission/task/workflow/artifact/…) via canonical_key, and NEVER
-- copies their mutable state — cross-system refs are validated in the service, not by FK.
CREATE TABLE IF NOT EXISTS brain_entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT,
  canonical_key TEXT,          -- kind:id, UNIQUE when present (one entity per canonical ref)
  canonical_ref_kind TEXT,
  canonical_ref_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_entities_canonical ON brain_entities (canonical_key);
CREATE INDEX IF NOT EXISTS idx_brain_entities_type ON brain_entities (type);
CREATE TABLE IF NOT EXISTS brain_relationships (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  type TEXT NOT NULL,
  strength REAL,
  metadata_json TEXT,
  source_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_relationships_edge ON brain_relationships (from_entity_id, to_entity_id, type);
CREATE INDEX IF NOT EXISTS idx_brain_relationships_from ON brain_relationships (from_entity_id);
CREATE INDEX IF NOT EXISTS idx_brain_relationships_to ON brain_relationships (to_entity_id);
CREATE TABLE IF NOT EXISTS brain_knowledge (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  kind TEXT NOT NULL DEFAULT 'note',
  confidence REAL,             -- nullable; NEVER fabricated
  source_id TEXT,
  created_by_agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_knowledge_source ON brain_knowledge (source_id);
CREATE TABLE IF NOT EXISTS brain_sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT,
  canonical_key TEXT,
  canonical_ref_kind TEXT,
  canonical_ref_id TEXT,
  uri TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_sources_canonical ON brain_sources (canonical_key);
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

// company_tasks (F0.2) gained F1 execution-reference columns. Additive + idempotent.
function migrateCompanyTasksTable(db: InstanceType<typeof Database>): void {
  const columns = new Set((db.pragma('table_info(company_tasks)') as { name: string }[]).map((c) => c.name));
  if (columns.size === 0) return; // table not created yet (fresh DBs get the columns via DDL)
  if (!columns.has('execution_kind')) db.exec('ALTER TABLE company_tasks ADD COLUMN execution_kind TEXT');
  if (!columns.has('execution_ref_id')) db.exec('ALTER TABLE company_tasks ADD COLUMN execution_ref_id TEXT');
  // Reliability G1: bounded attempt tracking + last-failure metadata (additive, idempotent).
  if (!columns.has('attempt_count')) db.exec('ALTER TABLE company_tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('max_attempts')) db.exec('ALTER TABLE company_tasks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3');
  if (!columns.has('last_failure_code')) db.exec('ALTER TABLE company_tasks ADD COLUMN last_failure_code TEXT');
  if (!columns.has('last_failure_class')) db.exec('ALTER TABLE company_tasks ADD COLUMN last_failure_class TEXT');
  if (!columns.has('last_failure_summary')) db.exec('ALTER TABLE company_tasks ADD COLUMN last_failure_summary TEXT');
  if (!columns.has('last_failure_at')) db.exec('ALTER TABLE company_tasks ADD COLUMN last_failure_at TEXT');
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
  // Reliability G1: preserve the machine-readable failure code of a failed run.
  if (!columns.has('error_code')) db.exec('ALTER TABLE agent_runs ADD COLUMN error_code TEXT');
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
  migrateCompanyTasksTable(db);
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

  // ── Company Registry capability layer (F0.1). Data + resolution only; no
  //    execution. `agent_id` is the canonical RuntimeAgent id (built-in OR
  //    custom-*), never an FK. Upsert/assign are idempotent (PK conflict → replace).
  type CapabilityRow = { id: string; name: string; description: string; domain: string; created_at: string };
  const rowToCapability = (r: CapabilityRow): Capability => ({
    id: r.id,
    name: r.name,
    description: r.description || undefined,
    domain: r.domain || undefined,
    createdAt: r.created_at,
  });
  const capabilities = {
    all(): Capability[] {
      return db.prepare('SELECT * FROM capabilities ORDER BY id').all().map((r) => rowToCapability(r as CapabilityRow));
    },
    get(id: string): Capability | null {
      const r = db.prepare('SELECT * FROM capabilities WHERE id = ?').get(id) as CapabilityRow | undefined;
      return r ? rowToCapability(r) : null;
    },
    /** Create-or-update a capability definition (validated + normalized). Idempotent. */
    upsert(input: unknown): Capability {
      const parsed = CapabilityInputSchema.parse(input);
      const createdAt = this.get(parsed.id)?.createdAt ?? new Date().toISOString();
      db.prepare('INSERT OR REPLACE INTO capabilities (id, name, description, domain, created_at) VALUES (?, ?, ?, ?, ?)').run(
        parsed.id,
        parsed.name,
        parsed.description ?? '',
        parsed.domain ?? domainOf(parsed.id),
        createdAt,
      );
      return this.get(parsed.id)!;
    },
    remove(id: string): void {
      db.prepare('DELETE FROM capabilities WHERE id = ?').run(id);
    },
  };

  type AgentCapabilityRow = { agent_id: string; capability_id: string; proficiency: number | null; source: string; created_at: string };
  const rowToAgentCapability = (r: AgentCapabilityRow): AgentCapability => ({
    agentId: r.agent_id,
    capabilityId: r.capability_id,
    proficiency: r.proficiency,
    source: (r.source as CapabilitySource) ?? 'explicit',
    createdAt: r.created_at,
  });
  const agentCapabilities = {
    all(): AgentCapability[] {
      return db.prepare('SELECT * FROM agent_capabilities ORDER BY agent_id, capability_id').all().map((r) => rowToAgentCapability(r as AgentCapabilityRow));
    },
    forAgent(agentId: string): AgentCapability[] {
      return db.prepare('SELECT * FROM agent_capabilities WHERE agent_id = ? ORDER BY capability_id').all(agentId).map((r) => rowToAgentCapability(r as AgentCapabilityRow));
    },
    forCapability(capabilityId: string): AgentCapability[] {
      return db.prepare('SELECT * FROM agent_capabilities WHERE capability_id = ? ORDER BY agent_id').all(capabilityId).map((r) => rowToAgentCapability(r as AgentCapabilityRow));
    },
    /** Assign a capability to an agent (validated). Idempotent: re-assigning updates in place. */
    assign(agentId: string, input: unknown): AgentCapability {
      const parsed = AgentCapabilityAssignSchema.parse(input);
      const prior = db.prepare('SELECT created_at FROM agent_capabilities WHERE agent_id = ? AND capability_id = ?').get(agentId, parsed.capabilityId) as { created_at: string } | undefined;
      const createdAt = prior?.created_at ?? new Date().toISOString();
      db.prepare('INSERT OR REPLACE INTO agent_capabilities (agent_id, capability_id, proficiency, source, created_at) VALUES (?, ?, ?, ?, ?)').run(
        agentId,
        parsed.capabilityId,
        parsed.proficiency ?? null,
        parsed.source,
        createdAt,
      );
      return rowToAgentCapability(db.prepare('SELECT * FROM agent_capabilities WHERE agent_id = ? AND capability_id = ?').get(agentId, parsed.capabilityId) as AgentCapabilityRow);
    },
    remove(agentId: string, capabilityId: string): void {
      db.prepare('DELETE FROM agent_capabilities WHERE agent_id = ? AND capability_id = ?').run(agentId, capabilityId);
    },
  };

  // ── Company work model (F0.2). Persistence only — validation/orchestration
  //    live in lib/company/service.ts. No execution here.
  type MissionRow = {
    id: string; title: string; objective: string; status: string; priority: string;
    created_by: string | null; created_at: string; updated_at: string; started_at: string | null; completed_at: string | null;
  };
  const rowToMission = (r: MissionRow): Mission => ({
    id: r.id,
    title: r.title,
    objective: r.objective || undefined,
    status: r.status as Mission['status'],
    priority: r.priority as Mission['priority'],
    createdBy: r.created_by ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at ?? undefined,
    completedAt: r.completed_at ?? undefined,
  });
  const companyMissions = {
    all(): Mission[] {
      return db.prepare('SELECT * FROM company_missions ORDER BY created_at DESC, id DESC').all().map((r) => rowToMission(r as MissionRow));
    },
    get(id: string): Mission | null {
      const r = db.prepare('SELECT * FROM company_missions WHERE id = ?').get(id) as MissionRow | undefined;
      return r ? rowToMission(r) : null;
    },
    insert(m: Mission): void {
      db.prepare(
        `INSERT OR REPLACE INTO company_missions (id, title, objective, status, priority, created_by, created_at, updated_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(m.id, m.title, m.objective ?? '', m.status, m.priority, m.createdBy ?? null, m.createdAt, m.updatedAt, m.startedAt ?? null, m.completedAt ?? null);
    },
    /** Delete one mission row (test-data cleanup; the service cascades owned records first). */
    delete(id: string): void {
      db.prepare('DELETE FROM company_missions WHERE id = ?').run(id);
    },
  };

  type CompanyTaskRow = {
    id: string; mission_id: string; parent_task_id: string | null; title: string; objective: string; status: string;
    assigned_agent_id: string | null; workflow_id: string | null; run_id: string | null; priority: string;
    required_capabilities: string; execution_kind: string | null; execution_ref_id: string | null;
    attempt_count: number | null; max_attempts: number | null;
    last_failure_code: string | null; last_failure_class: string | null; last_failure_summary: string | null; last_failure_at: string | null;
    created_at: string; updated_at: string; started_at: string | null; completed_at: string | null;
  };
  const rowToCompanyTask = (r: CompanyTaskRow): CompanyTask => ({
    id: r.id,
    missionId: r.mission_id,
    parentTaskId: r.parent_task_id ?? undefined,
    title: r.title,
    objective: r.objective || undefined,
    status: r.status as CompanyTask['status'],
    assignedAgentId: r.assigned_agent_id ?? undefined,
    workflowId: r.workflow_id ?? undefined,
    runId: r.run_id ?? undefined,
    executionKind: (r.execution_kind as CompanyTask['executionKind']) ?? undefined,
    executionRefId: r.execution_ref_id ?? undefined,
    priority: r.priority as CompanyTask['priority'],
    requiredCapabilities: parseJson<string[]>(r.required_capabilities, []),
    attemptCount: r.attempt_count ?? 0,
    maxAttempts: r.max_attempts ?? 3,
    lastFailureCode: r.last_failure_code ?? undefined,
    lastFailureClass: r.last_failure_class ?? undefined,
    lastFailureSummary: r.last_failure_summary ?? undefined,
    lastFailureAt: r.last_failure_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at ?? undefined,
    completedAt: r.completed_at ?? undefined,
  });
  const companyTasks = {
    get(id: string): CompanyTask | null {
      const r = db.prepare('SELECT * FROM company_tasks WHERE id = ?').get(id) as CompanyTaskRow | undefined;
      return r ? rowToCompanyTask(r) : null;
    },
    forMission(missionId: string): CompanyTask[] {
      return db.prepare('SELECT * FROM company_tasks WHERE mission_id = ? ORDER BY created_at, id').all(missionId).map((r) => rowToCompanyTask(r as CompanyTaskRow));
    },
    /** Every company task across all missions, oldest first (F6 Company Intelligence read model). */
    all(): CompanyTask[] {
      return db.prepare('SELECT * FROM company_tasks ORDER BY created_at, id').all().map((r) => rowToCompanyTask(r as CompanyTaskRow));
    },
    /** Delete every task of a mission (test-data cleanup; mission-scoped only). */
    deleteForMission(missionId: string): number {
      return db.prepare('DELETE FROM company_tasks WHERE mission_id = ?').run(missionId).changes;
    },
    insert(t: CompanyTask): void {
      db.prepare(
        `INSERT OR REPLACE INTO company_tasks
          (id, mission_id, parent_task_id, title, objective, status, assigned_agent_id, workflow_id, run_id, execution_kind, execution_ref_id, priority, required_capabilities, attempt_count, max_attempts, last_failure_code, last_failure_class, last_failure_summary, last_failure_at, created_at, updated_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        t.id, t.missionId, t.parentTaskId ?? null, t.title, t.objective ?? '', t.status, t.assignedAgentId ?? null,
        t.workflowId ?? null, t.runId ?? null, t.executionKind ?? null, t.executionRefId ?? null, t.priority,
        JSON.stringify(t.requiredCapabilities), t.attemptCount ?? 0, t.maxAttempts ?? 3,
        t.lastFailureCode ?? null, t.lastFailureClass ?? null, t.lastFailureSummary ?? null, t.lastFailureAt ?? null,
        t.createdAt, t.updatedAt, t.startedAt ?? null, t.completedAt ?? null,
      );
    },
  };

  // ── F1 Executive Manager: artifacts + event ledger ──
  type CompanyArtifactRow = {
    id: string; mission_id: string; task_id: string | null; produced_by_agent_id: string | null; workflow_run_id: string | null;
    type: string; title: string; summary: string | null; content_json: string | null; content_type: string | null;
    source_refs: string; created_at: string;
  };
  const rowToArtifact = (r: CompanyArtifactRow): CompanyArtifact => ({
    id: r.id,
    missionId: r.mission_id,
    taskId: r.task_id ?? undefined,
    producedByAgentId: r.produced_by_agent_id ?? undefined,
    workflowRunId: r.workflow_run_id ?? undefined,
    type: r.type,
    title: r.title,
    summary: r.summary ?? undefined,
    content: r.content_json === null ? undefined : parseJson<unknown>(r.content_json, null),
    contentType: r.content_type ?? undefined,
    sourceRefs: parseJson<string[]>(r.source_refs, []),
    createdAt: r.created_at,
  });
  const companyArtifacts = {
    get(id: string): CompanyArtifact | null {
      const r = db.prepare('SELECT * FROM company_artifacts WHERE id = ?').get(id) as CompanyArtifactRow | undefined;
      return r ? rowToArtifact(r) : null;
    },
    forMission(missionId: string): CompanyArtifact[] {
      return db.prepare('SELECT * FROM company_artifacts WHERE mission_id = ? ORDER BY created_at, id').all(missionId).map((r) => rowToArtifact(r as CompanyArtifactRow));
    },
    /** Delete every artifact of a mission (test-data cleanup; mission-scoped only). */
    deleteForMission(missionId: string): number {
      return db.prepare('DELETE FROM company_artifacts WHERE mission_id = ?').run(missionId).changes;
    },
    forTask(taskId: string): CompanyArtifact[] {
      return db.prepare('SELECT * FROM company_artifacts WHERE task_id = ? ORDER BY created_at, id').all(taskId).map((r) => rowToArtifact(r as CompanyArtifactRow));
    },
    insert(a: CompanyArtifact): void {
      db.prepare(
        `INSERT OR REPLACE INTO company_artifacts (id, mission_id, task_id, produced_by_agent_id, workflow_run_id, type, title, summary, content_json, content_type, source_refs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        a.id, a.missionId, a.taskId ?? null, a.producedByAgentId ?? null, a.workflowRunId ?? null, a.type, a.title,
        a.summary ?? null, a.content === undefined ? null : JSON.stringify(a.content), a.contentType ?? null,
        JSON.stringify(a.sourceRefs ?? []), a.createdAt,
      );
    },
  };

  type CompanyEventRow = {
    id: string; type: string; mission_id: string | null; task_id: string | null; agent_id: string | null;
    workflow_id: string | null; artifact_id: string | null; summary: string; metadata_json: string | null; created_at: string;
  };
  const rowToEvent = (r: CompanyEventRow): CompanyEvent => ({
    id: r.id,
    type: r.type as CompanyEventType,
    missionId: r.mission_id ?? undefined,
    taskId: r.task_id ?? undefined,
    agentId: r.agent_id ?? undefined,
    workflowId: r.workflow_id ?? undefined,
    artifactId: r.artifact_id ?? undefined,
    summary: r.summary,
    metadata: r.metadata_json === null ? undefined : parseJson<CompanyEvent['metadata']>(r.metadata_json, undefined),
    createdAt: r.created_at,
  });
  const companyEvents = {
    /** Append-only insert. */
    append(e: CompanyEvent): void {
      db.prepare(
        `INSERT INTO company_events (id, type, mission_id, task_id, agent_id, workflow_id, artifact_id, summary, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        e.id, e.type, e.missionId ?? null, e.taskId ?? null, e.agentId ?? null, e.workflowId ?? null, e.artifactId ?? null,
        e.summary, e.metadata === undefined ? null : JSON.stringify(e.metadata), e.createdAt,
      );
    },
    forMission(missionId: string, limit = 200): CompanyEvent[] {
      return db.prepare('SELECT * FROM company_events WHERE mission_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(missionId, limit).map((r) => rowToEvent(r as CompanyEventRow));
    },
    forTask(taskId: string, limit = 100): CompanyEvent[] {
      return db.prepare('SELECT * FROM company_events WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(taskId, limit).map((r) => rowToEvent(r as CompanyEventRow));
    },
    /** Count events of a type for a task — idempotency guard for critical events. */
    countForTask(taskId: string, type: string): number {
      const row = db.prepare('SELECT COUNT(*) AS n FROM company_events WHERE task_id = ? AND type = ?').get(taskId, type) as { n: number };
      return row.n;
    },
    /** One event by id (F5 Neural inspector). */
    get(id: string): CompanyEvent | null {
      const r = db.prepare('SELECT * FROM company_events WHERE id = ?').get(id) as CompanyEventRow | undefined;
      return r ? rowToEvent(r) : null;
    },
    /** Newest-first, bounded (F5 Neural company-now projection). */
    recent(limit = 200): CompanyEvent[] {
      return db.prepare('SELECT * FROM company_events ORDER BY created_at DESC, id DESC LIMIT ?').all(limit).map((r) => rowToEvent(r as CompanyEventRow));
    },
    /** Events at/after an ISO timestamp, newest-first, bounded (F5 Neural time window). */
    since(sinceIso: string, limit = 250): CompanyEvent[] {
      return db.prepare('SELECT * FROM company_events WHERE created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?').all(sinceIso, limit).map((r) => rowToEvent(r as CompanyEventRow));
    },
    /** Events referencing an agent, newest-first, bounded (F5 Neural agent focus). */
    forAgent(agentId: string, limit = 200): CompanyEvent[] {
      return db.prepare('SELECT * FROM company_events WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(agentId, limit).map((r) => rowToEvent(r as CompanyEventRow));
    },
    /** Delete every event of a mission — including events for its tasks (test-data cleanup). */
    deleteForMission(missionId: string, taskIds: string[] = []): number {
      let changes = db.prepare('DELETE FROM company_events WHERE mission_id = ?').run(missionId).changes;
      const del = db.prepare('DELETE FROM company_events WHERE task_id = ?');
      for (const t of taskIds) changes += del.run(t).changes;
      return changes;
    },
  };

  type CompanyTaskDepRow = { task_id: string; depends_on_task_id: string; created_at: string };
  const rowToTaskDep = (r: CompanyTaskDepRow): CompanyTaskDependency => ({ taskId: r.task_id, dependsOnTaskId: r.depends_on_task_id, createdAt: r.created_at });
  const companyTaskDeps = {
    /** Direct prerequisites of a task (task depends on …). */
    forTask(taskId: string): CompanyTaskDependency[] {
      return db.prepare('SELECT * FROM company_task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id').all(taskId).map((r) => rowToTaskDep(r as CompanyTaskDepRow));
    },
    /** All dependency edges whose endpoints are tasks in a mission (for cycle checks). */
    forMission(missionId: string): CompanyTaskDependency[] {
      return db
        .prepare(
          `SELECT d.* FROM company_task_dependencies d
           JOIN company_tasks t ON t.id = d.task_id
           WHERE t.mission_id = ? ORDER BY d.task_id, d.depends_on_task_id`,
        )
        .all(missionId)
        .map((r) => rowToTaskDep(r as CompanyTaskDepRow));
    },
    add(taskId: string, dependsOnTaskId: string): void {
      db.prepare('INSERT OR IGNORE INTO company_task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)').run(taskId, dependsOnTaskId, new Date().toISOString());
    },
    remove(taskId: string, dependsOnTaskId: string): void {
      db.prepare('DELETE FROM company_task_dependencies WHERE task_id = ? AND depends_on_task_id = ?').run(taskId, dependsOnTaskId);
    },
    /** Delete every dependency edge whose endpoints belong to a mission (test-data cleanup). */
    deleteForMission(missionId: string): number {
      return db
        .prepare('DELETE FROM company_task_dependencies WHERE task_id IN (SELECT id FROM company_tasks WHERE mission_id = ?)')
        .run(missionId).changes;
    },
  };

  // ── Agent Factory (F2). Persistence only — validation/orchestration live in
  //    lib/company/factory/service.ts. The proposal row is the pending, human-gated
  //    artifact; `resolve` mirrors flowApprovals.resolve (idempotent conditional
  //    transition of a `pending` row) so a double-approve promotes exactly once.
  type ProposalRow = {
    id: string; mission_id: string; task_id: string | null; status: string;
    spec_json: string; policy_json: string; required_capabilities: string; rationale: string | null;
    temporary: number; max_depth: number; budget_usd: number | null; agent_id: string | null;
    decided_by: string | null; decided_at: string | null; created_at: string; updated_at: string;
  };
  const rowToProposal = (r: ProposalRow): AgentProposal => ({
    id: r.id,
    missionId: r.mission_id,
    taskId: r.task_id ?? undefined,
    status: r.status as ProposalStatus,
    spec: parseJson<AgentSpec>(r.spec_json, {} as AgentSpec),
    policy: parseJson<FactoryPolicy>(r.policy_json, DEFAULT_FACTORY_POLICY),
    requiredCapabilities: parseJson<string[]>(r.required_capabilities, []),
    rationale: r.rationale ?? undefined,
    temporary: r.temporary === 1,
    maxDepth: r.max_depth,
    budgetUsd: r.budget_usd,
    agentId: r.agent_id ?? undefined,
    decidedBy: r.decided_by ?? undefined,
    decidedAt: r.decided_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const companyAgentProposals = {
    all(): AgentProposal[] {
      return db.prepare('SELECT * FROM company_agent_proposals ORDER BY created_at DESC, id DESC').all().map((r) => rowToProposal(r as ProposalRow));
    },
    forMission(missionId: string): AgentProposal[] {
      return db.prepare('SELECT * FROM company_agent_proposals WHERE mission_id = ? ORDER BY created_at DESC, id DESC').all(missionId).map((r) => rowToProposal(r as ProposalRow));
    },
    get(id: string): AgentProposal | null {
      const r = db.prepare('SELECT * FROM company_agent_proposals WHERE id = ?').get(id) as ProposalRow | undefined;
      return r ? rowToProposal(r) : null;
    },
    insert(p: AgentProposal): void {
      db.prepare(
        `INSERT OR REPLACE INTO company_agent_proposals
           (id, mission_id, task_id, status, spec_json, policy_json, required_capabilities, rationale,
            temporary, max_depth, budget_usd, agent_id, decided_by, decided_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        p.id, p.missionId, p.taskId ?? null, p.status, JSON.stringify(p.spec), JSON.stringify(p.policy),
        JSON.stringify(p.requiredCapabilities), p.rationale ?? null, p.temporary ? 1 : 0, p.maxDepth,
        p.budgetUsd ?? null, p.agentId ?? null, p.decidedBy ?? null, p.decidedAt ?? null, p.createdAt, p.updatedAt,
      );
    },
    /**
     * Conditionally resolve a PENDING proposal. Returns the row only when THIS call
     * performed the transition (`changes === 1`); a second concurrent approve/reject
     * sees `changes === 0` and gets `null` (idempotent — one decision wins).
     */
    resolve(id: string, status: 'approved' | 'rejected', decidedBy: string | null): AgentProposal | null {
      const nowIso = new Date().toISOString();
      const res = db
        .prepare("UPDATE company_agent_proposals SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(status, decidedBy, nowIso, nowIso, id);
      if (res.changes !== 1) return null;
      return this.get(id);
    },
    /** Link the created agent onto an already-approved proposal (promotion step 2). */
    setAgent(id: string, agentId: string): void {
      db.prepare('UPDATE company_agent_proposals SET agent_id = ?, updated_at = ? WHERE id = ?').run(agentId, new Date().toISOString(), id);
    },
    /** Delete every proposal of a mission (test-data cleanup; mission-scoped only). */
    deleteForMission(missionId: string): number {
      return db.prepare('DELETE FROM company_agent_proposals WHERE mission_id = ?').run(missionId).changes;
    },
  };

  // ── G-Brain Core (F3). Persistence only — validation/canonical-ref resolution live in
  //    lib/brain/core/*. Cross-system refs are validated in the service, never by FK.
  const refFromRow = (kind: string | null, id: string | null): CanonicalRef | undefined =>
    kind && id ? { kind: kind as CanonicalRefKind, id } : undefined;

  type BrainEntityRow = { id: string; type: string; name: string; summary: string | null; canonical_key: string | null; canonical_ref_kind: string | null; canonical_ref_id: string | null; created_at: string; updated_at: string };
  const rowToBrainEntity = (r: BrainEntityRow): BrainEntity => ({
    id: r.id,
    type: r.type as BrainEntityType,
    name: r.name,
    summary: r.summary ?? undefined,
    canonicalRef: refFromRow(r.canonical_ref_kind, r.canonical_ref_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const brainEntities = {
    all(): BrainEntity[] {
      return db.prepare('SELECT * FROM brain_entities ORDER BY created_at DESC, id DESC').all().map((r) => rowToBrainEntity(r as BrainEntityRow));
    },
    list(type?: string): BrainEntity[] {
      const rows = type
        ? db.prepare('SELECT * FROM brain_entities WHERE type = ? ORDER BY created_at DESC, id DESC').all(type)
        : db.prepare('SELECT * FROM brain_entities ORDER BY created_at DESC, id DESC').all();
      return rows.map((r) => rowToBrainEntity(r as BrainEntityRow));
    },
    get(id: string): BrainEntity | null {
      const r = db.prepare('SELECT * FROM brain_entities WHERE id = ?').get(id) as BrainEntityRow | undefined;
      return r ? rowToBrainEntity(r) : null;
    },
    getByCanonicalKey(key: string): BrainEntity | null {
      const r = db.prepare('SELECT * FROM brain_entities WHERE canonical_key = ?').get(key) as BrainEntityRow | undefined;
      return r ? rowToBrainEntity(r) : null;
    },
    insert(e: BrainEntity): void {
      const key = e.canonicalRef ? canonicalKey(e.canonicalRef.kind, e.canonicalRef.id) : null;
      db.prepare(
        'INSERT OR REPLACE INTO brain_entities (id, type, name, summary, canonical_key, canonical_ref_kind, canonical_ref_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(e.id, e.type, e.name, e.summary ?? null, key, e.canonicalRef?.kind ?? null, e.canonicalRef?.id ?? null, e.createdAt, e.updatedAt);
    },
  };

  type BrainRelationshipRow = { id: string; from_entity_id: string; to_entity_id: string; type: string; strength: number | null; metadata_json: string | null; source_id: string | null; created_at: string };
  const rowToBrainRelationship = (r: BrainRelationshipRow): BrainRelationship => ({
    id: r.id,
    fromEntityId: r.from_entity_id,
    toEntityId: r.to_entity_id,
    type: r.type as BrainRelationshipType,
    strength: r.strength,
    metadata: r.metadata_json === null ? undefined : parseJson<BrainRelationship['metadata']>(r.metadata_json, undefined),
    sourceId: r.source_id ?? undefined,
    createdAt: r.created_at,
  });
  const brainRelationships = {
    all(): BrainRelationship[] {
      return db.prepare('SELECT * FROM brain_relationships ORDER BY created_at DESC, id DESC').all().map((r) => rowToBrainRelationship(r as BrainRelationshipRow));
    },
    get(id: string): BrainRelationship | null {
      const r = db.prepare('SELECT * FROM brain_relationships WHERE id = ?').get(id) as BrainRelationshipRow | undefined;
      return r ? rowToBrainRelationship(r) : null;
    },
    /** Every relationship touching an entity, either direction. */
    forEntity(entityId: string): BrainRelationship[] {
      return db.prepare('SELECT * FROM brain_relationships WHERE from_entity_id = ? OR to_entity_id = ? ORDER BY created_at DESC, id DESC').all(entityId, entityId).map((r) => rowToBrainRelationship(r as BrainRelationshipRow));
    },
    /** An existing edge with the same (from, to, type), or null — the idempotency key. */
    find(fromEntityId: string, toEntityId: string, type: string): BrainRelationship | null {
      const r = db.prepare('SELECT * FROM brain_relationships WHERE from_entity_id = ? AND to_entity_id = ? AND type = ?').get(fromEntityId, toEntityId, type) as BrainRelationshipRow | undefined;
      return r ? rowToBrainRelationship(r) : null;
    },
    insert(rel: BrainRelationship): void {
      db.prepare(
        'INSERT OR REPLACE INTO brain_relationships (id, from_entity_id, to_entity_id, type, strength, metadata_json, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(rel.id, rel.fromEntityId, rel.toEntityId, rel.type, rel.strength ?? null, rel.metadata === undefined ? null : JSON.stringify(rel.metadata), rel.sourceId ?? null, rel.createdAt);
    },
  };

  type BrainKnowledgeRow = { id: string; title: string; content: string; summary: string | null; kind: string; confidence: number | null; source_id: string | null; created_by_agent_id: string | null; status: string; created_at: string; updated_at: string };
  const rowToBrainKnowledge = (r: BrainKnowledgeRow): BrainKnowledge => ({
    id: r.id,
    title: r.title,
    content: r.content,
    summary: r.summary ?? undefined,
    kind: r.kind as KnowledgeKind,
    confidence: r.confidence,
    sourceId: r.source_id ?? undefined,
    createdByAgentId: r.created_by_agent_id ?? undefined,
    status: r.status as KnowledgeStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const brainKnowledge = {
    all(): BrainKnowledge[] {
      return db.prepare('SELECT * FROM brain_knowledge ORDER BY created_at DESC, id DESC').all().map((r) => rowToBrainKnowledge(r as BrainKnowledgeRow));
    },
    get(id: string): BrainKnowledge | null {
      const r = db.prepare('SELECT * FROM brain_knowledge WHERE id = ?').get(id) as BrainKnowledgeRow | undefined;
      return r ? rowToBrainKnowledge(r) : null;
    },
    bySource(sourceId: string): BrainKnowledge[] {
      return db.prepare('SELECT * FROM brain_knowledge WHERE source_id = ? ORDER BY created_at, id').all(sourceId).map((r) => rowToBrainKnowledge(r as BrainKnowledgeRow));
    },
    insert(k: BrainKnowledge): void {
      db.prepare(
        'INSERT OR REPLACE INTO brain_knowledge (id, title, content, summary, kind, confidence, source_id, created_by_agent_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(k.id, k.title, k.content, k.summary ?? null, k.kind, k.confidence ?? null, k.sourceId ?? null, k.createdByAgentId ?? null, k.status, k.createdAt, k.updatedAt);
    },
  };

  type BrainSourceRow = { id: string; type: string; title: string | null; canonical_key: string | null; canonical_ref_kind: string | null; canonical_ref_id: string | null; uri: string | null; created_at: string };
  const rowToBrainSource = (r: BrainSourceRow): BrainSource => ({
    id: r.id,
    type: r.type as SourceType,
    title: r.title ?? undefined,
    canonicalRef: refFromRow(r.canonical_ref_kind, r.canonical_ref_id),
    uri: r.uri ?? undefined,
    createdAt: r.created_at,
  });
  const brainSources = {
    all(): BrainSource[] {
      return db.prepare('SELECT * FROM brain_sources ORDER BY created_at DESC, id DESC').all().map((r) => rowToBrainSource(r as BrainSourceRow));
    },
    get(id: string): BrainSource | null {
      const r = db.prepare('SELECT * FROM brain_sources WHERE id = ?').get(id) as BrainSourceRow | undefined;
      return r ? rowToBrainSource(r) : null;
    },
    getByCanonicalKey(key: string): BrainSource | null {
      const r = db.prepare('SELECT * FROM brain_sources WHERE canonical_key = ?').get(key) as BrainSourceRow | undefined;
      return r ? rowToBrainSource(r) : null;
    },
    insert(s: BrainSource): void {
      const key = s.canonicalRef ? canonicalKey(s.canonicalRef.kind, s.canonicalRef.id) : null;
      db.prepare(
        'INSERT OR REPLACE INTO brain_sources (id, type, title, canonical_key, canonical_ref_kind, canonical_ref_id, uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(s.id, s.type, s.title ?? null, key, s.canonicalRef?.kind ?? null, s.canonicalRef?.id ?? null, s.uri ?? null, s.createdAt);
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
    /** Recent runs across ALL workflows, newest first (Activity stream, U4). Deterministic tiebreak by id. */
    recent(limit = 50): FlowRun[] {
      return db
        .prepare('SELECT * FROM flow_runs ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(limit)
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
    /** Recent node runs across ALL runs, newest first (Activity stream, U4). Deterministic tiebreak by id. */
    recent(limit = 50): FlowNodeRun[] {
      return db
        .prepare('SELECT * FROM flow_node_runs ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(limit)
        .map((r) => rowToNodeRun(r as FlowNodeRunRow));
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
     * Recent approvals across ALL runs (any status), most-recently-changed first —
     * so a just-resolved approval surfaces in the Activity stream (U4). Ordered by
     * updated_at (resolution bumps it), deterministic tiebreak by id.
     */
    recent(limit = 50): FlowApproval[] {
      return db
        .prepare('SELECT * FROM flow_approvals ORDER BY updated_at DESC, id DESC LIMIT ?')
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
      errorCode: r.error_code ?? null,
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
        'INSERT OR REPLACE INTO agent_runs (id, agent_id, started_at, finished_at, ok, summary, error_code, model, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        run.id, run.agentId, run.startedAt, run.finishedAt, run.ok ? 1 : 0, run.summary,
        run.errorCode ?? null, run.model ?? null, run.tokensIn ?? null, run.tokensOut ?? null, run.costUsd ?? null,
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
    capabilities,
    agentCapabilities,
    companyMissions,
    companyTasks,
    companyTaskDeps,
    companyArtifacts,
    companyEvents,
    companyAgentProposals,
    brainEntities,
    brainRelationships,
    brainKnowledge,
    brainSources,
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
