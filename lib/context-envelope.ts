/**
 * IGRIS Context Envelope (UX Foundation U1).
 *
 * A single, tiny, app-wide record of WHAT THE USER IS CURRENTLY LOOKING AT — so
 * a future AI surface (the Commander, U2) can resolve "this workflow / this node
 * / this run" without importing any page-specific store.
 *
 * Hard boundaries (enforced by shape + tests):
 *  - Context ONLY. It never executes an action, never fetches, never mutates a
 *    workflow/draft, never saves/publishes/runs anything.
 *  - IDENTIFIERS + small flags only. NEVER secrets/tokens/auth headers, NEVER
 *    graphs, prompts, LLM outputs, tool arguments, or any large payload.
 *
 * State lives in a minimal external store (no new dependency) read via
 * `useIgrisContext()`; pages publish what they already know through the typed
 * `publish*` helpers. Pure transition functions carry all the logic so it is
 * unit-testable without React/DOM.
 */
import { useSyncExternalStore } from 'react';

export type IgrisSurface =
  | 'home'
  | 'flows'
  | 'agents'
  | 'approvals'
  | 'brain'
  | 'models'
  | 'settings'
  | 'other';

export type IgrisContextEnvelope = {
  route: string;
  surface: IgrisSurface;

  // /flows context (identifiers + small flags only)
  workflowId?: string;
  workflowVersion?: number; // the published version pointer, when known
  workflowDraft?: boolean; // true when the editable draft is the active surface
  selectedNodeId?: string;
  selectedEdgeId?: string;
  runId?: string;

  // other surfaces
  agentId?: string;
  approvalId?: string;

  updatedAt: number;
};

/** Flow selection a page may publish. Every field is optional; absent keys are left unchanged. */
export type FlowContextPatch = {
  workflowId?: string;
  workflowVersion?: number;
  workflowDraft?: boolean;
  selectedNodeId?: string;
  selectedEdgeId?: string;
  runId?: string;
};

/** The ONLY keys an envelope may ever contain (guards against payload creep). */
export const ENVELOPE_KEYS = [
  'route',
  'surface',
  'workflowId',
  'workflowVersion',
  'workflowDraft',
  'selectedNodeId',
  'selectedEdgeId',
  'runId',
  'agentId',
  'approvalId',
  'updatedAt',
] as const;

const FLOW_KEYS = ['workflowId', 'workflowVersion', 'workflowDraft', 'selectedNodeId', 'selectedEdgeId', 'runId'] as const;

/** Map a pathname to a coarse surface. Unknown routes are 'other'. */
export function surfaceForRoute(route: string): IgrisSurface {
  if (route === '/' || route === '') return 'home';
  if (route.startsWith('/flows')) return 'flows';
  if (route.startsWith('/agents')) return 'agents';
  if (route.startsWith('/approvals')) return 'approvals';
  if (route.startsWith('/brain')) return 'brain';
  if (route.startsWith('/models')) return 'models';
  if (route.startsWith('/settings')) return 'settings';
  return 'other';
}

export function defaultEnvelope(): IgrisContextEnvelope {
  return { route: '/', surface: 'home', updatedAt: 0 };
}

// ── Pure transitions (never mutate their inputs) ────────────────────────────

/**
 * Apply a route change. If the SURFACE changes (navigating away), every
 * entity id is dropped — stale flow/agent/approval context can never linger.
 * Same-surface navigation keeps the current selection.
 */
export function applyRoute(prev: IgrisContextEnvelope, route: string, now: number): IgrisContextEnvelope {
  const surface = surfaceForRoute(route);
  if (surface === prev.surface) return { ...prev, route, updatedAt: now };
  return { route, surface, updatedAt: now };
}

/**
 * Apply a /flows selection. Only keys PRESENT in the patch overwrite; a change
 * of `workflowId` additionally clears the stale node/edge/run selection.
 */
export function applyFlow(prev: IgrisContextEnvelope, patch: FlowContextPatch, now: number): IgrisContextEnvelope {
  const workflowChanged = 'workflowId' in patch && patch.workflowId !== prev.workflowId;
  const next: IgrisContextEnvelope = { ...prev };
  if (workflowChanged) {
    next.selectedNodeId = undefined;
    next.selectedEdgeId = undefined;
    next.runId = undefined;
  }
  for (const key of Object.keys(patch) as (keyof FlowContextPatch)[]) {
    (next as Record<string, unknown>)[key] = patch[key];
  }
  next.updatedAt = now;
  return next;
}

/** Drop all /flows context (e.g. the canvas closed) while keeping route/surface. */
export function clearFlow(prev: IgrisContextEnvelope, now: number): IgrisContextEnvelope {
  const next: IgrisContextEnvelope = { ...prev, updatedAt: now };
  for (const key of FLOW_KEYS) delete (next as Record<string, unknown>)[key];
  return next;
}

export function applyAgent(prev: IgrisContextEnvelope, agentId: string | undefined, now: number): IgrisContextEnvelope {
  return { ...prev, agentId, updatedAt: now };
}

const APPROVAL_KEYS = ['approvalId', 'runId', 'workflowId'] as const;

/**
 * Apply an /approvals selection (identifiers only). Merge-by-presence: only keys
 * PRESENT in the patch overwrite (pass an explicit `undefined` to clear one).
 * `workflowId` lets existing Commander context describe the paused run's workflow.
 */
export function applyApproval(
  prev: IgrisContextEnvelope,
  patch: { approvalId?: string; runId?: string; workflowId?: string },
  now: number,
): IgrisContextEnvelope {
  const next: IgrisContextEnvelope = { ...prev, updatedAt: now };
  if ('approvalId' in patch) next.approvalId = patch.approvalId;
  if ('runId' in patch) next.runId = patch.runId;
  if ('workflowId' in patch) next.workflowId = patch.workflowId;
  return next;
}

/** Drop all approval-selection context (card deselected) while keeping route/surface. */
export function clearApproval(prev: IgrisContextEnvelope, now: number): IgrisContextEnvelope {
  const next: IgrisContextEnvelope = { ...prev, updatedAt: now };
  for (const key of APPROVAL_KEYS) delete (next as Record<string, unknown>)[key];
  return next;
}

// ── Minimal external store (no dependency) ──────────────────────────────────

let state: IgrisContextEnvelope = defaultEnvelope();
const listeners = new Set<() => void>();
const now = (): number => (typeof Date !== 'undefined' ? Date.now() : 0);

function commit(next: IgrisContextEnvelope): void {
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l());
}

export function getIgrisContext(): IgrisContextEnvelope {
  return state;
}
export function subscribeIgrisContext(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Publish the current route (also derives the surface + clears stale context on surface change). */
export function publishRoute(route: string): void {
  commit(applyRoute(state, route, now()));
}
/** Publish the current /flows selection (identifiers + flags only). */
export function publishFlowContext(patch: FlowContextPatch): void {
  commit(applyFlow(state, patch, now()));
}
/** Drop /flows context (canvas closed / workflow deselected). */
export function clearFlowContext(): void {
  commit(clearFlow(state, now()));
}
export function publishAgentContext(agentId: string | undefined): void {
  commit(applyAgent(state, agentId, now()));
}
export function publishApprovalContext(patch: { approvalId?: string; runId?: string; workflowId?: string }): void {
  commit(applyApproval(state, patch, now()));
}
/** Drop approval-selection context (approval card deselected). */
export function clearApprovalContext(): void {
  commit(clearApproval(state, now()));
}

/** Test-only: reset the singleton so store tests don't leak into each other. */
export function __resetIgrisContextForTests(): void {
  state = defaultEnvelope();
  listeners.clear();
}

/**
 * Read the current context in a client component. The future Commander consumes
 * this — it never needs a page-specific store.
 */
export function useIgrisContext(): IgrisContextEnvelope {
  return useSyncExternalStore(subscribeIgrisContext, getIgrisContext, getIgrisContext);
}
