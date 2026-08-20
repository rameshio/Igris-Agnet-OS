/**
 * G-Brain Core — pure model (Architecture V2 · F3).
 *
 * The CANONICAL, durable, in-app company knowledge layer: Entities, Relationships,
 * Knowledge, and Sources/provenance. It is DISTINCT from — and must never be merged
 * with — the three other canonical systems (organization/agent registry, Flow engine,
 * company mission/task + execution ledger) and from the EXTERNAL gbrain markdown store
 * (`lib/brain.ts`) and the visualization graphs (`lib/brain-graph.ts` et al.).
 *
 * Load-bearing rules encoded here:
 *   - G-Brain REFERENCES canonical objects (`canonicalRef`) — it never copies their
 *     mutable state (an agent entity stores an id + safe name, never tools/model/status).
 *   - Closed enums for entity/relationship/knowledge/source types (controlled, extensible).
 *   - `confidence` is nullable and NEVER fabricated.
 *   - Safe projections expose id/type/name/summary/ref only — never secrets, never full
 *     knowledge/artifact content in list/feed contexts.
 *
 * PURE: zod only, no DB/LLM — so the enums, id rules, and projections are unit-testable
 * without SQLite.
 */
import { z, ZodError } from 'zod';

// ── Service error (self-contained; mirrors CompanyError's HTTP-status mapping) ──
export class BrainError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'BrainError';
  }
}

/** Map a thrown brain service/validation error to an HTTP status + safe message. */
export function brainErrorInfo(err: unknown): { status: number; error: string } {
  if (err instanceof BrainError) return { status: err.status, error: err.message };
  if (err instanceof ZodError) return { status: 400, error: err.issues.map((i) => i.message).join('; ') || 'invalid input' };
  return { status: 500, error: 'internal error' };
}

// ── Closed enums ──────────────────────────────────────────────────────────────
export const BRAIN_ENTITY_TYPES = [
  'person', 'agent', 'mission', 'task', 'workflow', 'artifact', 'skill', 'tool',
  'concept', 'organization', 'project', 'document', 'topic', 'knowledge',
] as const;
export type BrainEntityType = (typeof BRAIN_ENTITY_TYPES)[number];

/** Canonical systems a G-Brain entity/source may REFERENCE (never duplicate). */
export const CANONICAL_REF_KINDS = ['agent', 'mission', 'company_task', 'workflow', 'artifact', 'skill', 'tool', 'knowledge'] as const;
export type CanonicalRefKind = (typeof CANONICAL_REF_KINDS)[number];

export const BRAIN_RELATIONSHIP_TYPES = ['CAPABLE_OF', 'PRODUCED', 'HAS_TASK', 'ABOUT', 'DERIVED_FROM', 'RELATED_TO', 'REFERENCES', 'PART_OF'] as const;
export type BrainRelationshipType = (typeof BRAIN_RELATIONSHIP_TYPES)[number];

export const KNOWLEDGE_KINDS = ['fact', 'note', 'decision', 'finding', 'procedure', 'reference'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const SOURCE_TYPES = ['artifact', 'document', 'url', 'user', 'agent', 'workflow', 'system'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Which relationship types may self-link (from === to). Default: NONE in F3. */
const SELF_LINK_ALLOWED: ReadonlySet<BrainRelationshipType> = new Set<BrainRelationshipType>(['RELATED_TO']);
export function selfLinkAllowed(type: BrainRelationshipType): boolean {
  return SELF_LINK_ALLOWED.has(type);
}

// ── Canonical reference ────────────────────────────────────────────────────────
export type CanonicalRef = { kind: CanonicalRefKind; id: string };

/** Deterministic key for a canonical ref — e.g. `agent:custom-123`. Enforces entity uniqueness. */
export function canonicalKey(kind: CanonicalRefKind, id: string): string {
  return `${kind}:${id}`;
}

const CanonicalRefSchema = z.object({
  kind: z.enum(CANONICAL_REF_KINDS),
  id: z.string().trim().min(1).max(200),
});

// ── Safe metadata (bounded scalar map — mirrors company EventMetadataSchema) ────
export const BrainMetadataSchema = z
  .record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
  .refine((m) => Object.keys(m).length <= 12, 'metadata is bounded to 12 keys');
export type BrainMetadata = z.infer<typeof BrainMetadataSchema>;

// ── Entity ─────────────────────────────────────────────────────────────────────
export type BrainEntity = {
  id: string;
  type: BrainEntityType;
  name: string;
  summary?: string;
  canonicalRef?: CanonicalRef;
  createdAt: string;
  updatedAt: string;
};

export const BrainEntityInputSchema = z.object({
  type: z.enum(BRAIN_ENTITY_TYPES),
  name: z.string().trim().min(1).max(200),
  summary: z.string().max(2000).optional(),
  canonicalRef: CanonicalRefSchema.optional(),
});
export type BrainEntityInput = z.infer<typeof BrainEntityInputSchema>;

// ── Relationship ───────────────────────────────────────────────────────────────
export type BrainRelationship = {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  type: BrainRelationshipType;
  strength?: number | null;
  metadata?: BrainMetadata;
  sourceId?: string;
  createdAt: string;
};

export const BrainRelationshipInputSchema = z.object({
  fromEntityId: z.string().trim().min(1),
  toEntityId: z.string().trim().min(1),
  type: z.enum(BRAIN_RELATIONSHIP_TYPES),
  strength: z.number().min(0).max(1).nullable().optional(),
  metadata: BrainMetadataSchema.optional(),
  sourceId: z.string().trim().min(1).optional(),
});
export type BrainRelationshipInput = z.infer<typeof BrainRelationshipInputSchema>;

// ── Knowledge ────────────────────────────────────────────────────────────────
export const KNOWLEDGE_STATUSES = ['active', 'archived'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export type BrainKnowledge = {
  id: string;
  title: string;
  content: string;
  summary?: string;
  kind: KnowledgeKind;
  confidence?: number | null;
  sourceId?: string;
  createdByAgentId?: string;
  status: KnowledgeStatus;
  createdAt: string;
  updatedAt: string;
};

export const BrainKnowledgeInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20_000),
  summary: z.string().max(2000).optional(),
  kind: z.enum(KNOWLEDGE_KINDS).default('note'),
  confidence: z.number().min(0).max(1).nullable().optional(), // NEVER fabricated
  sourceId: z.string().trim().min(1).optional(),
  createdByAgentId: z.string().trim().min(1).optional(),
});
export type BrainKnowledgeInput = z.infer<typeof BrainKnowledgeInputSchema>;

export const BrainKnowledgeUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(20_000),
    summary: z.string().max(2000),
    kind: z.enum(KNOWLEDGE_KINDS),
    confidence: z.number().min(0).max(1).nullable(),
    status: z.enum(KNOWLEDGE_STATUSES),
  })
  .partial();
export type BrainKnowledgeUpdate = z.infer<typeof BrainKnowledgeUpdateSchema>;

// ── Source / provenance ──────────────────────────────────────────────────────
export type BrainSource = {
  id: string;
  type: SourceType;
  title?: string;
  canonicalRef?: CanonicalRef;
  uri?: string;
  createdAt: string;
};

export const BrainSourceInputSchema = z
  .object({
    type: z.enum(SOURCE_TYPES),
    title: z.string().max(200).optional(),
    canonicalRef: CanonicalRefSchema.optional(),
    uri: z.string().trim().max(2000).optional(),
  })
  .superRefine((v, ctx) => {
    // A `url` source must carry a valid http(s) URI; other types may omit it. We never
    // store credentials/auth here — a plain resource URL only.
    if (v.type === 'url') {
      if (!v.uri) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a url source requires a uri' });
        return;
      }
      try {
        const u = new URL(v.uri);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'uri must be a valid http(s) URL' });
      }
    }
  });
export type BrainSourceInput = z.infer<typeof BrainSourceInputSchema>;

// ── Safe projections ───────────────────────────────────────────────────────────
// Entities and sources carry no secret fields (an entity is id/type/name/summary/ref;
// a source is a type/title/ref/plain-URL), so their safe view is the whole record.
// Knowledge omits full `content` in list/feed contexts (a detail read returns content).
export function safeEntity(e: BrainEntity): BrainEntity {
  return e;
}
export function safeSource(s: BrainSource): BrainSource {
  return s;
}

export type SafeBrainKnowledge = Omit<BrainKnowledge, 'content'>;
export function safeKnowledge(k: BrainKnowledge): SafeBrainKnowledge {
  const { content: _content, ...rest } = k;
  return rest;
}

/** A bounded snippet around the first match of `needle` in `text` (search results). */
export function snippet(text: string, needle: string, span = 160): string {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return text.slice(0, span);
  const start = Math.max(0, i - Math.floor(span / 3));
  return (start > 0 ? '…' : '') + text.slice(start, start + span).trim() + (start + span < text.length ? '…' : '');
}
