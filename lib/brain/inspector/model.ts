/**
 * Universal Inspector — pure model (Architecture V2 · F4).
 *
 * One typed view model for EVERY inspectable canonical kind. The Inspector is a control
 * surface, NOT authority: its actions are a CLOSED, typed set that either navigate to the
 * owning surface (where the existing U3 / Phase-E confirm lives) or call an EXISTING API —
 * never a generic mutation, never an LLM-generated URL. Views carry safe fields only.
 */

export const INSPECTOR_KINDS = ['agent', 'mission', 'task', 'artifact', 'knowledge', 'workflow', 'source', 'approval', 'workflow_run', 'event'] as const;
export type InspectorKind = (typeof INSPECTOR_KINDS)[number];

export type InspectorRow = { label: string; value: string };
export type InspectorSection = { title: string; rows: InspectorRow[] };

/** Closed action ids — the ONLY actions the Inspector may offer. */
export const INSPECTOR_ACTION_IDS = [
  'open_agent', 'open_org', 'open_mission', 'open_flows', 'open_approvals', 'open_artifact_mission',
  'open_brain', 'promote_artifact', 'archive_knowledge',
] as const;
export type InspectorActionId = (typeof INSPECTOR_ACTION_IDS)[number];

/**
 * A navigate action deep-links to a canonical surface (immediate, non-mutating). An api
 * action calls an EXISTING endpoint (only the safe/idempotent/reversible ones — promote,
 * archive) behind a confirm. Every privileged/execution/destructive action is a `navigate`.
 */
export type InspectorAction =
  | { id: InspectorActionId; kind: 'navigate'; label: string; href: string }
  | { id: InspectorActionId; kind: 'api'; label: string; method: 'POST' | 'PATCH'; path: string; body?: Record<string, unknown>; confirm: true };

export type InspectorView = {
  entity: { id: string; kind: InspectorKind; label: string; status?: string };
  sections: InspectorSection[];
  actions: InspectorAction[];
};

export function isInspectorKind(k: string): k is InspectorKind {
  return (INSPECTOR_KINDS as readonly string[]).includes(k);
}
