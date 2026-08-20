/**
 * KG node-id conventions for the consolidated G-Brain (Architecture V2 · consolidation).
 *
 * The original radial/neural renderers key nodes by string id. The company-brain
 * adapter encodes each canonical entity into one of these ids so a click can be
 * reversed back to a canonical Inspector target. PURE + client-safe (no DB imports)
 * so the client controller can decode ids without pulling server code into the bundle.
 */
export const KG_SELF = 'self';

export const kgId = {
  mission: (id: string) => `team:${id}`,
  missionHead: (id: string) => `head:${id}`,
  task: (id: string) => `task:${id}`,
  agent: (id: string) => `emp:${id}`,
  artifact: (id: string) => `tool:artifact:${id}`,
  knowledge: (id: string) => `tool:knowledge:${id}`,
  workflow: (id: string) => `tool:workflow:${id}`,
  run: (id: string) => `tool:run:${id}`,
  approval: (id: string) => `tool:approval:${id}`,
  event: (id: string) => `tool:event:${id}`,
};

/** Reverse a KG node id → the canonical Inspector {kind,id}, or null (non-inspectable). */
export function inspectTargetForKgId(nodeId: string): { kind: string; id: string } | null {
  if (nodeId.startsWith('emp:')) return { kind: 'agent', id: nodeId.slice(4) };
  if (nodeId.startsWith('task:')) return { kind: 'task', id: nodeId.slice(5) };
  if (nodeId.startsWith('team:')) return { kind: 'mission', id: nodeId.slice(5) };
  if (nodeId.startsWith('tool:artifact:')) return { kind: 'artifact', id: nodeId.slice('tool:artifact:'.length) };
  if (nodeId.startsWith('tool:knowledge:')) return { kind: 'knowledge', id: nodeId.slice('tool:knowledge:'.length) };
  if (nodeId.startsWith('tool:workflow:')) return { kind: 'workflow', id: nodeId.slice('tool:workflow:'.length) };
  if (nodeId.startsWith('tool:run:')) return { kind: 'workflow_run', id: nodeId.slice('tool:run:'.length) };
  if (nodeId.startsWith('tool:approval:')) return { kind: 'approval', id: nodeId.slice('tool:approval:'.length) };
  if (nodeId.startsWith('tool:event:')) return { kind: 'event', id: nodeId.slice('tool:event:'.length) };
  return null; // self / mission-head / anything else has no canonical inspect target
}
