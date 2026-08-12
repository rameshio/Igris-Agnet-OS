/**
 * Hermes transport capabilities (HRA-2). Extracted so `hermes-serve.ts` and
 * `hermes-runtime.ts` can share them without a runtime import cycle through
 * `hermes-client.ts` (which imports the serve transport as a value). Re-exported
 * from `hermes-client.ts` for backward-compatible import paths.
 */
export type HermesTransport = 'acp' | 'cli' | 'gateway' | 'stub' | 'serve';

/** Tri-state so unverified capabilities (MCP/skills) are never reported as `true`. */
export type Tri = true | false | 'unknown';

export interface HermesCapabilities {
  chat: Tri;
  streaming: Tri;
  tools: Tri;
  mcp: Tri;
  skills: Tri;
  memory: Tri;
  cancellation: Tri;
  multiSession: Tri;
  /** Whether this transport has an out-of-band health probe (serve → GET /api/status). */
  healthProbe: boolean;
}

/**
 * Proven capability facts per transport. MCP + skills stay `'unknown'` everywhere
 * until verified live. Nothing here upgrades `unknown` to `true`.
 */
export const HERMES_CAPABILITIES: Record<HermesTransport, HermesCapabilities> = {
  acp: { chat: true, streaming: true, tools: true, mcp: 'unknown', skills: 'unknown', memory: true, cancellation: true, multiSession: false, healthProbe: false },
  cli: { chat: true, streaming: false, tools: false, mcp: 'unknown', skills: 'unknown', memory: 'unknown', cancellation: false, multiSession: false, healthProbe: false },
  serve: { chat: true, streaming: true, tools: true, mcp: 'unknown', skills: 'unknown', memory: true, cancellation: true, multiSession: true, healthProbe: true },
  gateway: { chat: true, streaming: 'unknown', tools: true, mcp: false, skills: false, memory: false, cancellation: false, multiSession: true, healthProbe: true },
  stub: { chat: true, streaming: false, tools: true, mcp: false, skills: false, memory: false, cancellation: false, multiSession: true, healthProbe: false },
};
