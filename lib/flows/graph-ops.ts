/**
 * Pure, framework-free graph edits for the /flows canvas (design-time draft only).
 *
 * These operate on the persisted WorkflowGraph shape so they can be unit-tested
 * without React/React Flow, and reused by the canvas. They NEVER touch the DB or
 * published versions — the canvas applies the result to its draft state and the
 * user Saves/Publishes as normal.
 */
import type { WorkflowGraph } from '@/lib/flows/schema';

/**
 * Remove a node and EVERY edge connected to it (incoming or outgoing). Returns a
 * new graph — the input is not mutated. No dangling edges are ever left behind.
 * Unknown ids are a no-op (returns an equivalent new graph).
 */
export function removeNodeFromGraph(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  return {
    ...graph,
    nodes: (graph.nodes ?? []).filter((n) => n.id !== nodeId),
    edges: (graph.edges ?? []).filter((e) => e.source !== nodeId && e.target !== nodeId),
  };
}

/** ids of every edge touching a node — the set the canvas must also drop. */
export function connectedEdgeIds(graph: WorkflowGraph, nodeId: string): string[] {
  return (graph.edges ?? []).filter((e) => e.source === nodeId || e.target === nodeId).map((e) => e.id);
}

const DELETE_KEYS = new Set(['Delete', 'Backspace']);

/**
 * Whether a keypress should delete the selected canvas node. True only for
 * Delete/Backspace AND only when the user is NOT typing in a text field — so a
 * Backspace inside an inspector input/textarea edits text instead of nuking the
 * node. `editing` is "is the focused element a text-entry control".
 */
export function shouldDeleteSelection(opts: { key: string; editing: boolean }): boolean {
  if (opts.editing) return false;
  return DELETE_KEYS.has(opts.key);
}

/** DOM helper: is this element a text-entry control (so Delete/Backspace must NOT delete a node)? */
export function isEditableTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
