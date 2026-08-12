/**
 * Typed workflow definition schemas for the /flows orchestrator (Phase A).
 *
 * A workflow is a directed graph of typed nodes + edges. Nodes are a
 * discriminated union on `type`; each type carries its own `config`. Edges
 * describe how data moves (Phase A defaults to passing the whole output; richer
 * field/template mapping arrives in Phase D but the shape is reserved now so we
 * don't hit an architectural dead-end).
 *
 * These schemas are pure (no DB / React) so the validator, the API, and the UI
 * can all share them.
 */
import { z } from 'zod';
import { ConditionSchema } from '@/lib/flows/conditions';

export const NODE_TYPES = [
  'input',
  'agent',
  'tool',
  'decision',
  'approval',
  'memory',
  'transform',
  'parallel',
  'join',
  'output',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

// ── Per-type config. Only `agent` carries execution-relevant data in Phase A;
//    the rest are structural placeholders until their phase lands.
export const InputConfigSchema = z.object({
  value: z.string().default(''),
  format: z.enum(['text', 'json', 'url', 'file']).default('text'),
});
export const AgentConfigSchema = z.object({
  agentId: z.string().min(1),
  // `providerId:modelId` (Models board) or blank = default brain. Phase B formalizes.
  model: z.string().optional(),
});
export const ToolConfigSchema = z.object({ toolSlug: z.string().optional() });
/**
 * Decision (Phase D): an ordered rule list evaluated FIRST-MATCH (spec §55). Each
 * rule names the route it selects when its condition is true; `defaultRoute` is
 * the fallback when nothing matches. Edges leaving a decision reference the route
 * via `sourceHandle` (spec §13). `config:{}` parses to an empty rule list.
 */
export const DecisionRuleSchema = z.object({
  route: z.string().min(1),
  condition: ConditionSchema,
});
export const DecisionConfigSchema = z.object({
  rules: z.array(DecisionRuleSchema).default([]),
  defaultRoute: z.string().optional(),
});
/**
 * Human Approval node (Phase E). A human gate, kept strictly separate from the
 * machine-logic Decision node. `message` may use `{{Node.field}}` references
 * (resolved by the SAME references.ts resolver — no new parser). `approveRoute`
 * / `rejectRoute` are source-handle labels: approve activates ONLY the approve
 * edge, reject ONLY the reject edge (routes exactly like a Decision).
 */
export const ApprovalConfigSchema = z.object({
  title: z.string().max(200).default('Human approval required'),
  message: z.string().max(4000).default(''),
  approveRoute: z.string().min(1).max(80).default('approve'),
  rejectRoute: z.string().min(1).max(80).default('reject'),
  approveLabel: z.string().max(80).default('Approve'),
  rejectLabel: z.string().max(80).default('Reject'),
  /** Names of upstream references to snapshot into the approver's context view. */
  contextFields: z.array(z.string().max(200)).max(20).default([]),
});
export const MemoryConfigSchema = z.object({
  mode: z.enum(['search', 'read', 'write', 'update']).default('search'),
  write: z.boolean().default(false),
});
/**
 * Transform (Phase D): a declarative, code-free reshape (spec §19/§21).
 *  - `object`   → build an object from `{ key: "{{ref}}" }` (values type-preserved)
 *  - `template` → produce text from a `{{ref}}` string
 *  - `field`    → pass a single reference through
 */
export const TransformConfigSchema = z.object({
  mode: z.enum(['object', 'template', 'field']).default('object'),
  object: z.record(z.string(), z.string()).optional(),
  template: z.string().optional(),
  field: z.string().optional(),
});
/** Parallel (Phase D): a control fan-out; optional labels name the outgoing branches (spec §45). */
export const ParallelConfigSchema = z.object({ branches: z.array(z.string()).optional() });
/** Join (Phase D): v1 waits for ALL active incoming branches (spec §26). */
export const JoinConfigSchema = z.object({ mode: z.enum(['all']).default('all') });
export const OutputConfigSchema = z.object({
  mode: z.enum(['display', 'save', 'draft', 'notify']).default('display'),
});

/** Map of node type → its config schema. Shared by the executor registry + validator. */
export const NODE_CONFIG_SCHEMAS: Record<NodeType, z.ZodTypeAny> = {
  input: InputConfigSchema,
  agent: AgentConfigSchema,
  tool: ToolConfigSchema,
  decision: DecisionConfigSchema,
  approval: ApprovalConfigSchema,
  memory: MemoryConfigSchema,
  transform: TransformConfigSchema,
  parallel: ParallelConfigSchema,
  join: JoinConfigSchema,
  output: OutputConfigSchema,
};

const nodeBase = {
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  label: z.string().max(120).optional(),
  /** Optional author note shown in the inspector; carried on every node type. */
  description: z.string().max(500).optional(),
};
const nodeOf = <T extends NodeType>(type: T, config: z.ZodTypeAny) =>
  z.object({ ...nodeBase, type: z.literal(type), config });

export const WorkflowNodeSchema = z.discriminatedUnion('type', [
  nodeOf('input', InputConfigSchema),
  nodeOf('agent', AgentConfigSchema),
  nodeOf('tool', ToolConfigSchema),
  nodeOf('decision', DecisionConfigSchema),
  nodeOf('approval', ApprovalConfigSchema),
  nodeOf('memory', MemoryConfigSchema),
  nodeOf('transform', TransformConfigSchema),
  nodeOf('parallel', ParallelConfigSchema),
  nodeOf('join', JoinConfigSchema),
  nodeOf('output', OutputConfigSchema),
]);
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

/**
 * Edge data mapping (Phase D, spec §7). `all` (the Phase-A/B/C default) passes the
 * whole upstream output; `field`/`template`/`object` resolve `{{Node.field}}`
 * references. Legacy edges with `mapping:{ mode:'all' }` (or no mapping) are
 * unchanged.
 */
export const EdgeMappingSchema = z.object({
  mode: z.enum(['all', 'field', 'template', 'object']).default('all'),
  field: z.string().optional(),
  template: z.string().optional(),
  object: z.record(z.string(), z.string()).optional(),
});
export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  /** For decision routing: the source route this edge leaves from (spec §13). */
  sourceHandle: z.string().nullable().optional(),
  /** Stable branch label used by Join to key its inputs (spec §25). */
  targetHandle: z.string().nullable().optional(),
  mapping: EdgeMappingSchema.default({ mode: 'all' }),
  /** Optional conditional edge (spec §16). Same evaluator as Decision. */
  condition: ConditionSchema.optional(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export const ViewportSchema = z.object({ x: z.number(), y: z.number(), zoom: z.number() });

/** The canonical graph payload persisted per draft / version. */
export const WorkflowGraphSchema = z.object({
  nodes: z.array(WorkflowNodeSchema).max(200).default([]),
  edges: z.array(WorkflowEdgeSchema).max(500).default([]),
  viewport: ViewportSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;

/** Full definition = identity + version + graph. */
export const WorkflowDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(''),
  version: z.number().int().nonnegative().default(0),
  nodes: WorkflowGraphSchema.shape.nodes,
  edges: WorkflowGraphSchema.shape.edges,
  viewport: ViewportSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] };
