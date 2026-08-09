/**
 * Node executor registry — the extension point for node behavior.
 *
 * Each node type registers: its config validator and (later) its executor. The
 * validator + API use this instead of scattering `switch (node.type)` across the
 * app; adding a node type is one `register(...)` call.
 *
 * Phase A registers config validators for every type but NO executors — the new
 * execution engine lands in Phase C. `executable` is therefore false for all
 * types today; `runNode` throws an explicit "not executable yet" so nothing ever
 * pretends to run. The registry shape already carries `execute` so wiring real
 * executors later is additive, not a rewrite.
 */
import type { z } from 'zod';
import { NODE_CONFIG_SCHEMAS, type NodeType, type WorkflowNode } from '@/lib/flows/schema';
import { NODE_TYPE_META } from '@/lib/flows/node-types';
import type { NodeOutput, NodeRunMeta, StartRunInput } from '@/lib/flows/run-types';
import type { FounderDb } from '@/lib/db';
import type { RuntimeAgent } from '@/lib/agents/runtime';

export type { NodeOutput } from '@/lib/flows/run-types';

/** Execution context handed to an executor by the engine (Phase C). */
export type NodeExecContext = {
  node: WorkflowNode;
  /** Resolved input for this node (upstream outputs merged by the engine). */
  input: NodeOutput;
  /** Structured state of already-succeeded nodes, keyed by node id. */
  state: Record<string, NodeOutput>;
  /** The run's starting input. */
  startingInput: StartRunInput;
  db: FounderDb;
  /** All runtime agents (built-in + custom) for agent-node resolution. */
  agents: RuntimeAgent[];
  signal?: AbortSignal;
};

/** What an executor returns: its output + optional model-call metadata. */
export type NodeExecResult = { output: NodeOutput; meta?: NodeRunMeta };

export interface NodeExecutor {
  type: NodeType;
  /** True once this executor can actually run. */
  executable: boolean;
  /** Validate a node's config; returns human-readable errors ([] = valid). */
  validateConfig(config: unknown): string[];
  /** Run the node. Absent until the type's phase lands. */
  execute?(ctx: NodeExecContext): Promise<NodeExecResult>;
}

class NodeExecutorRegistry {
  private readonly executors = new Map<NodeType, NodeExecutor>();

  register(executor: NodeExecutor): void {
    this.executors.set(executor.type, executor);
  }
  get(type: NodeType): NodeExecutor | undefined {
    return this.executors.get(type);
  }
  has(type: NodeType): boolean {
    return this.executors.has(type);
  }
  all(): NodeExecutor[] {
    return [...this.executors.values()];
  }
  isExecutable(type: NodeType): boolean {
    return this.executors.get(type)?.executable ?? false;
  }
}

/** Validate a node config against its type's Zod schema → human-readable errors. */
export function validateNodeConfig(type: NodeType, config: unknown): string[] {
  const schema: z.ZodTypeAny = NODE_CONFIG_SCHEMAS[type];
  const parsed = schema.safeParse(config);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`);
}

/** A config-only executor: validates via the type's Zod schema, cannot run yet. */
function configOnlyExecutor(type: NodeType): NodeExecutor {
  return { type, executable: false, validateConfig: (config) => validateNodeConfig(type, config) };
}

export const nodeExecutorRegistry = new NodeExecutorRegistry();

// Phase A: register a config validator for every known type. Executors (the
// `execute` fn) are added type-by-type in later phases (agent/input/output → C,
// decision/transform/parallel/join → D, approval → E, memory → F, tool → later).
for (const type of Object.keys(NODE_TYPE_META) as NodeType[]) {
  nodeExecutorRegistry.register(configOnlyExecutor(type));
}
