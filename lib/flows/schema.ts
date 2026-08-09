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
export const DecisionConfigSchema = z.object({
  branches: z.array(z.object({ name: z.string().min(1), expression: z.string().min(1) })).default([]),
});
export const ApprovalConfigSchema = z.object({ note: z.string().optional() });
export const MemoryConfigSchema = z.object({
  mode: z.enum(['search', 'read', 'write', 'update']).default('search'),
  write: z.boolean().default(false),
});
export const TransformConfigSchema = z.object({ expression: z.string().default('') });
export const ParallelConfigSchema = z.object({});
export const JoinConfigSchema = z.object({});
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

export const EdgeMappingSchema = z.object({
  mode: z.enum(['all', 'field', 'template']).default('all'),
  field: z.string().optional(),
  template: z.string().optional(),
});
export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullable().optional(),
  targetHandle: z.string().nullable().optional(),
  mapping: EdgeMappingSchema.default({ mode: 'all' }),
  condition: z.string().optional(),
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
