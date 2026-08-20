/**
 * G-Brain Radial projection — pure model (Architecture V2 · F4).
 *
 * The Radial view is a PROJECTION, not a source of truth. It combines, around a selected
 * entity, both:
 *   - PERSISTED G-Brain edges (F3 `brain_relationships`, e.g. Knowledge DERIVED_FROM Artifact)
 *   - PROJECTED canonical edges resolved live from the owning systems (e.g. Mission HAS_TASK
 *     Task from Company Core) — these are NEVER written back to `brain_relationships`.
 * Every node/edge is tagged `persisted: boolean` so the two are visually distinguishable and
 * the projection ≠ persistence rule is explicit.
 *
 * This module is PURE (no DB/LLM): the closed node/edge enums, the deterministic node/edge
 * keys, the bounds, and the deep-link ref parser are unit-testable without SQLite. The parser
 * is strict — a URL parameter can only address a typed canonical/brain ref, never an
 * arbitrary query.
 */

// Visual node kinds a radial node may take.
export const RADIAL_NODE_KINDS = [
  'agent', 'mission', 'task', 'workflow', 'artifact', 'knowledge',
  'concept', 'skill', 'tool', 'source', 'approval', 'capability', 'department',
] as const;
export type RadialNodeKind = (typeof RADIAL_NODE_KINDS)[number];

// Edge types: F3 persisted relationship types + the projected canonical relations.
export const RADIAL_EDGE_TYPES = [
  // persisted (F3)
  'CAPABLE_OF', 'PRODUCED', 'HAS_TASK', 'ABOUT', 'DERIVED_FROM', 'RELATED_TO', 'REFERENCES', 'PART_OF',
  // projected (canonical, live)
  'ASSIGNED_TO', 'DEPENDS_ON', 'REQUIRES', 'USES_WORKFLOW', 'IN_DEPARTMENT',
] as const;
export type RadialEdgeType = (typeof RADIAL_EDGE_TYPES)[number];

export type BrainGraphNode = {
  id: string; // canonical key, e.g. `mission:mission-123` (dedup key)
  kind: RadialNodeKind;
  label: string;
  subtitle?: string;
  canonicalRef?: { kind: string; id: string };
  status?: string;
  expandable: boolean;
  persisted: boolean; // true = backed by a persisted BrainEntity; false = live projection node
};

export type BrainGraphEdge = {
  id: string; // `${from}|${type}|${to}`
  from: string;
  to: string;
  type: RadialEdgeType;
  label?: string;
  persisted: boolean; // true = a persisted brain_relationships row; false = projected live
};

export type RadialGraph = {
  root: string; // the root node id
  nodes: BrainGraphNode[];
  edges: BrainGraphEdge[];
  truncated: boolean; // a bound was hit (more neighbors exist than shown)
};

// ── Bounds (conservative — no "load the whole company graph") ─────────────────
export const RADIAL_MAX_NODES = 100;
export const RADIAL_MAX_EDGES = 200;
export const RADIAL_DEFAULT_DEPTH = 1;
export const RADIAL_MAX_DEPTH = 2;

export function clampDepth(d: number | undefined): number {
  if (!Number.isFinite(d)) return RADIAL_DEFAULT_DEPTH;
  return Math.max(1, Math.min(Math.trunc(d as number), RADIAL_MAX_DEPTH));
}
export function clampLimit(n: number | undefined): number {
  if (!Number.isFinite(n)) return RADIAL_MAX_NODES;
  return Math.max(1, Math.min(Math.trunc(n as number), RADIAL_MAX_NODES));
}

/** Deterministic node key. `kind` is the CANONICAL ref kind namespace (e.g. `company_task`). */
export function nodeKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}
/** Deterministic edge id (dedup key). */
export function edgeId(from: string, to: string, type: RadialEdgeType): string {
  return `${from}|${type}|${to}`;
}

// ── Deep-link / root reference parsing (strict) ───────────────────────────────
// A root may be addressed as a brain id (`bent-*`/`bkno-*`/`bsrc-*`) or `kind:id`.
export const RADIAL_REF_KINDS = [
  'brain_entity', 'agent', 'mission', 'company_task', 'workflow', 'artifact', 'knowledge', 'skill', 'tool', 'source', 'concept',
] as const;
export type RadialRefKind = (typeof RADIAL_REF_KINDS)[number];

export type ParsedRef = { kind: RadialRefKind; id: string };

/**
 * Parse a radial root reference. Accepts `bent-*`/`bkno-*`/`bsrc-*` brain ids, or a
 * `kind:id` canonical reference (`task` is accepted as an alias for `company_task`).
 * Returns null for anything malformed — a URL parameter can NEVER become an arbitrary query.
 */
export function parseEntityRef(param: string | null | undefined): ParsedRef | null {
  const s = (param ?? '').trim();
  if (!s || s.length > 220) return null;
  if (/^bent-[A-Za-z0-9-]+$/.test(s)) return { kind: 'brain_entity', id: s };
  if (/^bkno-[A-Za-z0-9-]+$/.test(s)) return { kind: 'knowledge', id: s };
  if (/^bsrc-[A-Za-z0-9-]+$/.test(s)) return { kind: 'source', id: s };
  const m = /^([a-z_]+):([A-Za-z0-9_-]{1,200})$/.exec(s);
  if (!m) return null;
  const kind = m[1] === 'task' ? 'company_task' : m[1];
  if (!(RADIAL_REF_KINDS as readonly string[]).includes(kind)) return null;
  return { kind: kind as RadialRefKind, id: m[2] };
}

/** Map a persisted G-Brain canonical-ref kind to the radial node key namespace + visual kind. */
export function radialKindForCanonical(refKind: string): { keyKind: string; nodeKind: RadialNodeKind } {
  switch (refKind) {
    case 'company_task':
      return { keyKind: 'company_task', nodeKind: 'task' };
    case 'agent':
      return { keyKind: 'agent', nodeKind: 'agent' };
    case 'mission':
      return { keyKind: 'mission', nodeKind: 'mission' };
    case 'workflow':
      return { keyKind: 'workflow', nodeKind: 'workflow' };
    case 'artifact':
      return { keyKind: 'artifact', nodeKind: 'artifact' };
    case 'knowledge':
      return { keyKind: 'knowledge', nodeKind: 'knowledge' };
    case 'skill':
      return { keyKind: 'skill', nodeKind: 'skill' };
    case 'tool':
      return { keyKind: 'tool', nodeKind: 'tool' };
    default:
      return { keyKind: 'concept', nodeKind: 'concept' };
  }
}
