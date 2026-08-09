/**
 * Client-authored workflows. The operator fills a name, subtitle, and a list of
 * steps (each with an owner and the tools it connects); this module assigns the
 * ids, ordering, and the advanced analytics fields (hours / leak / automation)
 * with safe defaults, then persists a full Workflow the process map can render.
 */
import { randomUUID } from 'node:crypto';
import type { FounderDb } from '@/lib/db';
import { WorkflowInputSchema, type Workflow, type WorkflowInput, type WorkflowStep } from '@/lib/schemas';

function toStep(input: WorkflowInput['steps'][number]): WorkflowStep {
  return {
    id: `step-${randomUUID()}`,
    title: input.title,
    ownerKind: input.ownerKind,
    owner: input.owner,
    hoursPerWeek: 0,
    tools: input.tools,
    edgeLabel: null,
    leakUsd: null,
    automation: null,
  };
}

/** Validate a create payload, assign identity + order, persist, return it. */
export function createWorkflow(db: FounderDb, input: unknown): Workflow {
  const parsed = WorkflowInputSchema.parse(input);
  const workflow: Workflow = {
    id: `wf-${randomUUID()}`,
    name: parsed.name,
    subtitle: parsed.subtitle,
    revenueUsd: 0,
    order: db.workflows.maxOrder() + 1,
    steps: parsed.steps.map(toStep),
  };
  db.workflows.insert(workflow);
  return workflow;
}

/** Replace an existing workflow's editable fields; keeps its id + order. */
export function updateWorkflow(db: FounderDb, id: string, input: unknown): Workflow {
  const existing = db.workflows.get(id);
  if (!existing) throw new Error(`unknown workflow: ${id}`);
  const parsed = WorkflowInputSchema.parse(input);
  const workflow: Workflow = {
    ...existing,
    name: parsed.name,
    subtitle: parsed.subtitle,
    steps: parsed.steps.map(toStep),
  };
  db.workflows.insert(workflow);
  return workflow;
}
