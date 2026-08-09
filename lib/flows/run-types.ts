/**
 * Workflow run + node-run types (Phase C). Execution history is kept strictly
 * separate from the workflow DEFINITION (flow_workflows/flow_versions): a run
 * references an immutable version and never writes runtime status back into a
 * graph. Node output is JSON-capable ({text?, data?}), not a plain string.
 */
import { z } from 'zod';

export const RUN_STATUSES = ['queued', 'running', 'success', 'failed', 'canceled', 'interrupted'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// `waiting_approval` is reserved for Phase E — declared but never produced here.
export const NODE_RUN_STATUSES = ['queued', 'running', 'success', 'failed', 'skipped', 'waiting_approval'] as const;
export type NodeRunStatus = (typeof NODE_RUN_STATUSES)[number];

export const NodeOutputSchema = z.object({ text: z.string().optional(), data: z.unknown().optional() });
export type NodeOutput = z.infer<typeof NodeOutputSchema>;

/** The run's starting input (Phase C: text). Structured/file inputs are later. */
export const StartRunInputSchema = z.object({ text: z.string().max(20_000).default('') });
export type StartRunInput = z.infer<typeof StartRunInputSchema>;

export type FlowRun = {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: RunStatus;
  startingInput: StartRunInput;
  currentNodeId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  createdAt: string;
  updatedAt: string;
};

export type FlowNodeRun = {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  status: NodeRunStatus;
  input: unknown | null; // resolved input actually handed to the executor
  output: NodeOutput | null;
  providerId: string | null;
  modelId: string | null;
  modelStrategy: string | null;
  adapter: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Metadata an executor may return alongside its output (agent → model call). */
export type NodeRunMeta = {
  strategy?: string;
  adapter?: string;
  providerId?: string;
  modelId?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCost?: number | null;
  fallbackUsed?: boolean;
};
