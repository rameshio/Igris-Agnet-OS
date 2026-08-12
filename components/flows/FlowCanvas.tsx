'use client';

/**
 * Typed workflow canvas (Phase A). Generic React Flow board driven by the node
 * type registry (lib/flows/node-types) — NOT hardcoded to agents. Every node
 * type can be placed; only their execution lands in later phases, so nodes
 * honestly show "not runnable yet" for their pending phase.
 *
 * The canvas converts between React Flow's shape and the persisted
 * WorkflowGraph, saves the draft (PATCH), and publishes immutable versions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Bot,
  Wrench,
  GitFork,
  UserCheck,
  Database,
  Shuffle,
  Split,
  Merge,
  LogIn,
  LogOut,
  Save,
  UploadCloud,
  Loader2,
  Check,
  X,
  Play,
  type LucideIcon,
} from 'lucide-react';
import { NODE_TYPE_META, NODE_TYPE_LIST } from '@/lib/flows/node-types';
import type { NodeType, WorkflowGraph, WorkflowNode, WorkflowEdge } from '@/lib/flows/schema';
import { parseModelSettings, describeModel } from '@/lib/models/settings';
import { providerById } from '@/lib/models/catalog';
import { NodeInspector, EdgeInspector, type EdgeData } from '@/components/flows/InspectorPanel';
import { shouldDeleteSelection, isEditableTarget } from '@/lib/flows/graph-ops';

const ICONS: Record<string, LucideIcon> = {
  Bot, Wrench, GitFork, UserCheck, Database, Shuffle, Split, Merge, LogIn, LogOut,
};

type AgentOption = { id: string; name: string; model?: string };
type RunNodeStatus = 'idle' | 'queued' | 'running' | 'success' | 'failed' | 'skipped' | 'waiting_approval' | 'rejected';
type WFNodeData = { nodeType: NodeType; label?: string; description?: string; config: Record<string, unknown>; agentName?: string; agentModel?: string; status?: RunNodeStatus };
type WFNode = Node<WFNodeData>;

const RUN_DOT: Record<RunNodeStatus, string> = {
  idle: 'bg-os-dim',
  queued: 'bg-os-dim',
  running: 'bg-os-warn animate-pulse',
  success: 'bg-os-ok',
  failed: 'bg-os-err',
  skipped: 'bg-os-dim opacity-50',
  waiting_approval: 'bg-os-warn animate-pulse',
  rejected: 'bg-os-err opacity-70',
};

/** Human model badge for an agent, derived from the agent's stored model string. */
function agentModelBadge(model?: string): string {
  const s = parseModelSettings(model);
  return describeModel(s, { providerName: s.config.providerId ? providerById(s.config.providerId)?.name : undefined });
}

const uid = (p: string) => `${p}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

function defaultConfig(type: NodeType): Record<string, unknown> {
  switch (type) {
    case 'input': return { value: '', format: 'text' };
    case 'memory': return { mode: 'search', write: false };
    case 'output': return { mode: 'display' };
    case 'decision': return { rules: [], defaultRoute: '' };
    case 'transform': return { mode: 'object', object: {} };
    case 'join': return { mode: 'all' };
    case 'approval': return { title: 'Human approval required', message: '', approveRoute: 'approve', rejectRoute: 'reject', approveLabel: 'Approve', rejectLabel: 'Reject', contextFields: [] };
    default: return {};
  }
}

/** Short canvas label for an edge, showing its route / mapping / condition at a glance. */
function edgeBadge(data: EdgeData): string | undefined {
  const parts: string[] = [];
  if (data.route) parts.push(`▶ ${data.route}`);
  if (data.mapping && data.mapping.mode !== 'all') parts.push(data.mapping.mode);
  if (data.condition) parts.push('if…');
  return parts.length ? parts.join(' · ') : undefined;
}

/** One node renderer for every type — category color + icon + text, never color alone. */
function TypedNode({ data, selected }: NodeProps<WFNode>) {
  const meta = NODE_TYPE_META[data.nodeType];
  const Icon = ICONS[meta.icon] ?? Bot;
  return (
    <div
      className="min-w-[168px] rounded-md border bg-os-surface px-3 py-2"
      style={{ borderColor: selected ? meta.color : 'var(--border)', boxShadow: `inset 3px 0 0 ${meta.color}` }}
      title={meta.description}
    >
      {data.nodeType !== 'input' && (
        <Handle type="target" position={Position.Left} style={{ background: meta.color, width: 8, height: 8 }} />
      )}
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: meta.color }} />
        <span className="truncate text-[11px] font-bold text-os-text">{data.label || meta.label}</span>
        {data.status && data.status !== 'idle' && <span className={`ml-auto h-2 w-2 shrink-0 rounded-full ${RUN_DOT[data.status]}`} title={data.status} />}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="font-mono text-[8.5px] uppercase tracking-wider text-os-dim">{meta.label}</span>
        {data.nodeType === 'agent' && data.agentName && (
          <span className="truncate font-mono text-[8.5px] text-os-muted">· {data.agentName}</span>
        )}
      </div>
      {data.nodeType === 'agent' && data.agentModel && (
        <div className="mt-0.5 truncate font-mono text-[8.5px] text-os-dim">{data.agentModel}</div>
      )}
      {!meta.executable && (
        <div className="mt-1 rounded-sm-t bg-os-raised px-1.5 py-0.5 font-mono text-[8px] text-os-dim">
          not runnable yet · Phase {meta.runnablePhase}
        </div>
      )}
      {data.nodeType !== 'output' && (
        <Handle type="source" position={Position.Right} style={{ background: meta.color, width: 8, height: 8 }} />
      )}
    </div>
  );
}

const nodeTypes = { wf: TypedNode };

function graphToRF(graph: WorkflowGraph, findAgent: (id: string) => AgentOption | undefined): { nodes: WFNode[]; edges: Edge[] } {
  const nodes: WFNode[] = (graph.nodes ?? []).map((n) => {
    const agent = n.type === 'agent' ? findAgent((n.config as { agentId?: string }).agentId ?? '') : undefined;
    return {
      id: n.id,
      type: 'wf' as const,
      position: { x: n.x, y: n.y },
      data: {
        nodeType: n.type,
        label: n.label,
        description: n.description,
        config: n.config as Record<string, unknown>,
        agentName: agent?.name,
        agentModel: agent ? agentModelBadge(agent.model) : undefined,
      },
    };
  });
  const edges: Edge[] = (graph.edges ?? []).map((e) => {
    const data: EdgeData = {
      mapping: e.mapping as EdgeData['mapping'],
      condition: e.condition,
      route: e.sourceHandle ?? undefined,
      branchLabel: e.targetHandle ?? undefined,
    };
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      // Our nodes expose single unnamed handles; route/branch labels live in `data`.
      animated: true,
      label: edgeBadge(data),
      labelBgStyle: { fill: 'var(--surface)' },
      labelStyle: { fontSize: 9, fill: 'var(--muted)' },
      data,
    };
  });
  return { nodes, edges };
}

function rfToGraph(nodes: WFNode[], edges: Edge[]): WorkflowGraph {
  return {
    nodes: nodes.map(
      (n): WorkflowNode =>
        ({ id: n.id, type: n.data.nodeType, x: Math.round(n.position.x), y: Math.round(n.position.y), label: n.data.label, description: n.data.description, config: n.data.config }) as WorkflowNode,
    ),
    edges: edges.map((e): WorkflowEdge => {
      const data = (e.data as EdgeData | undefined) ?? {};
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: data.route ?? null,
        targetHandle: data.branchLabel ?? null,
        mapping: data.mapping ?? { mode: 'all' as const },
        condition: data.condition,
      };
    }),
  };
}

type NodeRunView = {
  id: string;
  nodeId: string;
  nodeType: string;
  status: RunNodeStatus;
  providerId: string | null;
  modelId: string | null;
  modelStrategy: string | null;
  adapter: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  input: unknown;
  output: { text?: string; data?: unknown } | null;
};
type ApprovalView = {
  id: string;
  nodeId: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  title: string;
  message: string;
  approvalRoute: string;
  rejectionRoute: string;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
};
type RunView = {
  run: { id: string; status: string; workflowVersion: number; totalTokens: number | null; startedAt: string | null; endedAt: string | null; errorCode: string | null; errorMessage: string | null };
  nodeRuns: NodeRunView[];
  approvals?: ApprovalView[];
  finalOutput: { text?: string } | null;
};
type RunListItem = { id: string; status: string; workflowVersion: number; startedAt: string | null; endedAt: string | null };

const TERMINAL = new Set(['success', 'failed', 'canceled', 'interrupted']);

export function FlowCanvas({
  workflowId,
  initialGraph,
  agents,
  currentVersion,
  onPublished,
}: {
  workflowId: string;
  initialGraph: WorkflowGraph;
  agents: AgentOption[];
  currentVersion?: number | null;
  onPublished?: (version: number) => void;
}) {
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const seed = useMemo(() => graphToRF(initialGraph, (id) => agentById.get(id)), [initialGraph, agentById]);
  const [nodes, setNodes, onNodesChange] = useNodesState<WFNode>(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(seed.edges);
  const [saving, setSaving] = useState<false | 'save' | 'publish'>(false);
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [agentPick, setAgentPick] = useState(false);
  const [version, setVersion] = useState<number | null>(currentVersion ?? null);
  const [dirty, setDirty] = useState(false);
  const [startText, setStartText] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [editNode, setEditNode] = useState<string | null>(null);
  const [editEdge, setEditEdge] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [apprNote, setApprNote] = useState('');
  const [resolving, setResolving] = useState(false);

  const onConnect = useCallback(
    (c: Connection) => {
      setEdges((eds) => addEdge({ ...c, id: uid('e'), animated: true, data: { mapping: { mode: 'all' } } }, eds));
      setDirty(true);
    },
    [setEdges],
  );

  // Design-time editing: patch a node's config / label, or an edge's data.
  const patchNodeConfig = useCallback(
    (nodeId: string, config: Record<string, unknown>) => {
      setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, config } } : n)));
      setDirty(true);
    },
    [setNodes],
  );
  const patchNodeLabel = useCallback(
    (nodeId: string, label: string) => {
      setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, label: label || undefined } } : n)));
      setDirty(true);
    },
    [setNodes],
  );
  const patchNodeDescription = useCallback(
    (nodeId: string, description: string) => {
      setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, description: description || undefined } } : n)));
      setDirty(true);
    },
    [setNodes],
  );
  // Delete a node from the DRAFT (never a published version): drop the node AND
  // every edge connected to it, so no dangling edges remain. Close its inspector.
  const deleteNode = useCallback(
    (nodeId: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== nodeId));
      setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setEditNode((cur) => (cur === nodeId ? null : cur));
      setSelNode((cur) => (cur === nodeId ? null : cur));
      setDirty(true);
      setSaved(false);
    },
    [setNodes, setEdges],
  );

  // Keyboard delete: Delete/Backspace removes the inspector-selected node — but
  // only when the user is NOT typing in a text field (guarded by isEditableTarget),
  // so Backspace edits text inside the inspector instead of nuking the node.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!editNode) return;
      if (!shouldDeleteSelection({ key: e.key, editing: isEditableTarget(document.activeElement) })) return;
      e.preventDefault();
      deleteNode(editNode);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editNode, deleteNode]);
  const patchEdgeData = useCallback(
    (edgeId: string, data: EdgeData) => {
      setEdges((es) => es.map((e) => (e.id === edgeId ? { ...e, data, label: edgeBadge(data) } : e)));
      setDirty(true);
    },
    [setEdges],
  );

  const loadRuns = useCallback(async () => {
    const res = await fetch(`/api/flows/${workflowId}/runs`).catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    if (j?.runs) setRuns(j.runs);
  }, [workflowId]);
  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  // Overlay run node-statuses onto the canvas (never mutates the definition).
  useEffect(() => {
    const byNode = new Map((run?.nodeRuns ?? []).map((nr) => [nr.nodeId, nr.status]));
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: (byNode.get(n.id) as RunNodeStatus) ?? 'idle' } })));
  }, [run, setNodes]);

  // Poll an active run ~1s; stop on terminal.
  useEffect(() => {
    if (!runId) return;
    const tick = async () => {
      const res = await fetch(`/api/flows/runs/${runId}`).catch(() => null);
      const j = res ? await res.json().catch(() => null) : null;
      if (j?.run) {
        setRun(j as RunView);
        if (TERMINAL.has(j.run.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          void loadRuns();
        }
      }
    };
    void tick();
    pollRef.current = setInterval(tick, 1000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [runId, loadRuns]);

  const addNode = (type: NodeType, config?: Record<string, unknown>, label?: string, agentName?: string) => {
    setNodes((ns) => [
      ...ns,
      {
        id: uid(type),
        type: 'wf',
        position: { x: 80 + (ns.length % 5) * 190, y: 60 + Math.floor(ns.length / 5) * 130 },
        data: {
          nodeType: type,
          label,
          config: config ?? defaultConfig(type),
          agentName,
          agentModel: type === 'agent' ? agentModelBadge((config?.model as string | undefined) ?? undefined) : undefined,
        },
      },
    ]);
    setSaved(false);
    setDirty(true);
  };

  const save = async () => {
    setSaving('save');
    setNote(null);
    const res = await fetch(`/api/flows/${workflowId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: rfToGraph(nodes, edges) }),
    }).catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    setSaving(false);
    if (!res?.ok) {
      setNote(j?.error ?? 'Save failed.');
      return;
    }
    setSaved(true);
    const issues = j?.validation?.issues ?? [];
    setNote(issues.length ? `Saved. ${issues.length} validation issue(s): ${issues[0].message}` : 'Saved.');
  };

  const publish = async () => {
    setSaving('publish');
    setNote(null);
    // Save the draft first so the snapshot reflects the canvas.
    await fetch(`/api/flows/${workflowId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: rfToGraph(nodes, edges) }),
    }).catch(() => null);
    const res = await fetch(`/api/flows/${workflowId}/versions`, { method: 'POST' }).catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    setSaving(false);
    if (!res?.ok) {
      const issue = j?.validation?.issues?.[0]?.message;
      setNote(j?.error ? `${j.error}${issue ? ` — ${issue}` : ''}` : 'Publish failed.');
      return;
    }
    setNote(`✓ Published version ${j.version}.`);
    setVersion(j.version);
    setDirty(false);
    onPublished?.(j.version);
  };

  const runFlow = async () => {
    if (version == null) {
      setNote('Publish this workflow before running it.');
      return;
    }
    setNote(null);
    setRun(null);
    const res = await fetch(`/api/flows/${workflowId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { text: startText } }),
    }).catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    if (!res?.ok || !j?.runId) {
      const issue = j?.validation?.issues?.[0]?.message;
      setNote(j?.error ? `${j.error}${issue ? ` — ${issue}` : ''}` : 'Run failed to start.');
      return;
    }
    setSelNode(null);
    setRunId(j.runId);
  };

  const openRun = (id: string) => {
    setSelNode(null);
    setRunId(id);
  };

  // Resolve a pending Human Approval, then immediately refresh the run so the UI
  // reflects the resume without waiting for the next poll tick. The backend
  // resolves everything from the approval id — we send only the decision + note.
  const resolveApproval = async (approvalId: string, decision: 'approve' | 'reject') => {
    setResolving(true);
    const res = await fetch(`/api/flow-approvals/${approvalId}/${decision}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: apprNote.trim() || undefined }),
    }).catch(() => null);
    setResolving(false);
    if (!res?.ok) {
      setNote('Failed to resolve approval.');
      return;
    }
    setApprNote('');
    const runRes = await fetch(`/api/flows/runs/${runId}`).catch(() => null);
    const j = runRes ? await runRes.json().catch(() => null) : null;
    if (j?.run) setRun(j as RunView);
  };
  const pendingApproval = run?.approvals?.find((a) => a.status === 'pending') ?? null;

  const btn = 'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-50';
  const fmtMs = (ms: number | null) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);
  const selectedNodeRun = run?.nodeRuns.find((nr) => nr.id === selNode) ?? null;

  const editingNode = editNode ? nodes.find((n) => n.id === editNode) ?? null : null;
  const editingEdge = editEdge ? edges.find((e) => e.id === editEdge) ?? null : null;
  const editingEdgeSource = editingEdge ? nodes.find((n) => n.id === editingEdge.source) ?? null : null;
  const decisionRoutesFor = (n: WFNode | null): string[] => {
    if (n?.data.nodeType === 'approval') {
      // Approval routes like a decision: the two source handles are its approve/reject labels.
      const approve = (n.data.config.approveRoute as string) || 'approve';
      const reject = (n.data.config.rejectRoute as string) || 'reject';
      return [...new Set([approve, reject])];
    }
    const rules = (n?.data.config.rules as { route: string }[]) ?? [];
    const def = n?.data.config.defaultRoute as string | undefined;
    const set = new Set(rules.map((r) => r.route).filter(Boolean));
    if (def) set.add(def);
    return [...set];
  };
  const selectedRoute = (selectedNodeRun?.output?.data as { selectedRoute?: string } | undefined)?.selectedRoute;

  return (
    <div className="flex h-full flex-col">
      {/* palette */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-os-border pb-2">
        <span className="mr-1 text-[9px] uppercase tracking-[0.2em] text-os-dim">add node</span>
        {NODE_TYPE_LIST.map((m) => {
          const Icon = ICONS[m.icon] ?? Bot;
          if (m.type === 'agent') {
            return (
              <div key={m.type} className="relative">
                <button
                  onClick={() => setAgentPick((v) => !v)}
                  className="flex items-center gap-1 rounded border border-os-border bg-os-bg px-2 py-1 text-[10.5px] text-os-muted hover:border-os-border-bright hover:text-os-text"
                  style={{ boxShadow: `inset 2px 0 0 ${m.color}` }}
                >
                  <Icon className="h-3 w-3" style={{ color: m.color }} /> {m.label}
                </button>
                {agentPick && (
                  <div className="absolute z-20 mt-1 max-h-56 w-52 overflow-y-auto rounded-md border border-os-border-bright bg-os-bg p-1 shadow-lg">
                    {agents.length === 0 && <div className="px-2 py-1 font-mono text-[10px] text-os-dim">No agents — create one on /agents.</div>}
                    {agents.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => {
                          addNode('agent', { agentId: a.id, model: a.model }, a.name, a.name);
                          setAgentPick(false);
                        }}
                        className="block w-full truncate rounded px-2 py-1 text-left text-[11px] text-os-muted hover:bg-os-surface2 hover:text-os-text"
                      >
                        {a.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          return (
            <button
              key={m.type}
              onClick={() => addNode(m.type)}
              title={m.description}
              className="flex items-center gap-1 rounded border border-os-border bg-os-bg px-2 py-1 text-[10.5px] text-os-muted hover:border-os-border-bright hover:text-os-text"
              style={{ boxShadow: `inset 2px 0 0 ${m.color}` }}
            >
              <Icon className="h-3 w-3" style={{ color: m.color }} /> {m.label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={save} disabled={!!saving} className={`${btn} border-os-border text-os-muted hover:text-os-text`}>
            {saving === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5 text-os-ok" /> : <Save className="h-3.5 w-3.5" />} Save
          </button>
          <button onClick={publish} disabled={!!saving} className={`${btn} border-os-border-bright bg-os-text text-os-bg hover:opacity-90`}>
            {saving === 'publish' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />} Publish version
          </button>
        </div>
      </div>

      {note && (
        <p className="flex items-center gap-1.5 py-1.5 font-mono text-[10.5px] text-os-muted">
          {note}
          <button onClick={() => setNote(null)} className="text-os-dim hover:text-os-text"><X className="h-3 w-3" /></button>
        </p>
      )}

      {/* run bar — SAVE draft · PUBLISH version · RUN published version */}
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[9px] uppercase tracking-[0.2em] text-os-dim">starting input</div>
          <textarea
            value={startText}
            onChange={(e) => setStartText(e.target.value)}
            rows={2}
            placeholder="Text handed to the workflow's Input node…"
            className="mt-1 w-full resize-y rounded border border-os-border bg-os-bg px-2 py-1.5 text-[11.5px] text-os-text placeholder:text-os-dim focus:border-os-border-bright focus:outline-none"
          />
        </div>
        <div className="flex flex-col items-end gap-1">
          {dirty && <span className="font-mono text-[9px] text-os-warn">unpublished changes — Publish to run latest</span>}
          <button onClick={runFlow} disabled={version == null} className={`${btn} border-os-border-bright bg-os-text text-os-bg hover:opacity-90`}>
            <Play className="h-3.5 w-3.5" /> {version == null ? 'Publish to run' : `Run v${version}`}
          </button>
        </div>
      </div>

      <div className="mt-2 flex min-h-0 flex-1 gap-3">
        <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-os-border bg-os-bg">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={(c) => { onNodesChange(c); if (c.some((x) => x.type === 'remove' || x.type === 'position')) setDirty(true); }}
            onEdgesChange={(c) => { onEdgesChange(c); if (c.some((x) => x.type === 'remove')) setDirty(true); }}
            onConnect={onConnect}
            onNodeClick={(_, n) => { setEditEdge(null); setEditNode(n.id); }}
            onEdgeClick={(_, e) => { setEditNode(null); setEditEdge(e.id); }}
            onPaneClick={() => { setEditNode(null); setEditEdge(null); }}
            nodeTypes={nodeTypes}
            // Node deletion is handled by our own keyboard/inspector logic (guarded
            // against deleting while typing in an input) — disable RF's built-in key.
            deleteKeyCode={null}
            fitView
            colorMode="system"
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} size={1} color="var(--border-strong)" />
            <MiniMap pannable zoomable className="!bg-os-surface2" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {(editingNode || editingEdge) && (
          <aside className="w-72 shrink-0 overflow-y-auto rounded-md border border-os-border bg-os-surface p-3">
            {editingNode && (
              <NodeInspector
                nodeId={editingNode.id}
                nodeType={editingNode.data.nodeType}
                label={editingNode.data.label}
                description={editingNode.data.description}
                config={editingNode.data.config}
                onConfig={(c) => patchNodeConfig(editingNode.id, c)}
                onLabel={(l) => patchNodeLabel(editingNode.id, l)}
                onDescription={(d) => patchNodeDescription(editingNode.id, d)}
                onDelete={() => deleteNode(editingNode.id)}
                onClose={() => setEditNode(null)}
              />
            )}
            {editingEdge && (
              <EdgeInspector
                edgeId={editingEdge.id}
                data={(editingEdge.data as EdgeData) ?? {}}
                sourceType={editingEdgeSource?.data.nodeType}
                decisionRoutes={
                  editingEdgeSource?.data.nodeType === 'decision' || editingEdgeSource?.data.nodeType === 'approval'
                    ? decisionRoutesFor(editingEdgeSource)
                    : []
                }
                onData={(d) => patchEdgeData(editingEdge.id, d)}
                onClose={() => setEditEdge(null)}
              />
            )}
          </aside>
        )}

        {(run || runs.length > 0) && (
          <aside className="flex w-72 shrink-0 flex-col overflow-y-auto rounded-md border border-os-border bg-os-surface p-3">
            {run ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-bold text-os-text">Run · v{run.run.workflowVersion}</div>
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                      run.run.status === 'success' ? 'text-os-ok' : run.run.status === 'failed' || run.run.status === 'interrupted' ? 'text-os-err' : 'text-os-warn'
                    }`}
                  >
                    {run.run.status}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-[9px] text-os-dim">
                  {run.run.startedAt && run.run.endedAt ? `${((new Date(run.run.endedAt).getTime() - new Date(run.run.startedAt).getTime()) / 1000).toFixed(1)}s` : 'running…'} · tokens {run.run.totalTokens ?? '—'} · cost —
                </div>
                {run.run.errorMessage && <p className="mt-1 font-mono text-[9px] text-os-err">{run.run.errorCode}: {run.run.errorMessage}</p>}

                {pendingApproval && (
                  <div className="mt-2 rounded border border-os-warn/60 bg-os-warn/5 p-2">
                    <div className="text-[10px] font-bold text-os-warn">⏸ Awaiting approval</div>
                    <div className="mt-0.5 text-[10.5px] font-semibold text-os-text">{pendingApproval.title}</div>
                    {pendingApproval.message && <p className="mt-0.5 whitespace-pre-wrap font-mono text-[9.5px] text-os-muted">{pendingApproval.message}</p>}
                    <textarea
                      value={apprNote}
                      onChange={(e) => setApprNote(e.target.value)}
                      placeholder="Note (optional)"
                      rows={2}
                      className="mt-1.5 w-full resize-none rounded border border-os-border bg-os-bg px-1.5 py-1 font-mono text-[9.5px] text-os-text placeholder:text-os-dim"
                    />
                    <div className="mt-1.5 flex gap-1.5">
                      <button
                        onClick={() => resolveApproval(pendingApproval.id, 'approve')}
                        disabled={resolving}
                        className="flex-1 rounded border border-os-ok/60 px-2 py-1 text-[10px] font-semibold text-os-ok hover:bg-os-ok/10 disabled:opacity-50"
                      >
                        Approve → {pendingApproval.approvalRoute}
                      </button>
                      <button
                        onClick={() => resolveApproval(pendingApproval.id, 'reject')}
                        disabled={resolving}
                        className="flex-1 rounded border border-os-err/60 px-2 py-1 text-[10px] font-semibold text-os-err hover:bg-os-err/10 disabled:opacity-50"
                      >
                        Reject → {pendingApproval.rejectionRoute}
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-2 space-y-0.5">
                  {run.nodeRuns.map((nr) => (
                    <button key={nr.id} onClick={() => setSelNode(nr.id)} className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-os-bg ${selNode === nr.id ? 'bg-os-bg' : ''}`}>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${RUN_DOT[(nr.status as RunNodeStatus)] ?? 'bg-os-dim'}`} />
                      <span className="truncate text-[10.5px] text-os-text">{nr.nodeType}</span>
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-os-dim">{fmtMs(nr.durationMs)}</span>
                    </button>
                  ))}
                </div>

                {selectedNodeRun && (
                  <div className="mt-2 rounded border border-os-border bg-os-bg p-2">
                    <div className="text-[10px] font-bold text-os-text">{selectedNodeRun.nodeType}</div>
                    {(selectedNodeRun.providerId || selectedNodeRun.modelStrategy) && (
                      <div className="mt-0.5 font-mono text-[9px] text-os-muted">
                        {selectedNodeRun.modelStrategy} · {selectedNodeRun.adapter}
                        {selectedNodeRun.providerId ? ` · ${selectedNodeRun.providerId}:${selectedNodeRun.modelId}` : ''}
                        {selectedNodeRun.totalTokens != null ? ` · ${selectedNodeRun.totalTokens} tok` : ''}
                      </div>
                    )}
                    {selectedNodeRun.status === 'skipped' ? (
                      <div className="mt-1 font-mono text-[9px] text-os-dim">skipped — {selectedNodeRun.errorMessage ?? selectedNodeRun.errorCode ?? 'branch not selected'}</div>
                    ) : (
                      selectedNodeRun.errorCode && <div className="mt-1 font-mono text-[9px] text-os-err">{selectedNodeRun.errorCode}: {selectedNodeRun.errorMessage}</div>
                    )}
                    {(selectedNodeRun.nodeType === 'decision' || selectedNodeRun.nodeType === 'approval') && selectedRoute && (
                      <div className="mt-1 font-mono text-[9.5px] text-os-text">selected route: <span className="text-os-ok">{selectedRoute}</span></div>
                    )}
                    <div className="mt-1 text-[8.5px] uppercase tracking-wider text-os-dim">output</div>
                    <p className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[9.5px] text-os-muted">{selectedNodeRun.output?.text ?? '—'}</p>
                  </div>
                )}

                {run.finalOutput?.text && (
                  <div className="mt-2">
                    <div className="text-[8.5px] uppercase tracking-wider text-os-dim">final output</div>
                    <p className="mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] text-os-text">{run.finalOutput.text}</p>
                  </div>
                )}
              </>
            ) : (
              <div className="font-mono text-[10px] text-os-dim">No active run — pick one below.</div>
            )}

            {runs.length > 0 && (
              <div className="mt-3 border-t border-os-border pt-2">
                <div className="text-[9px] uppercase tracking-[0.2em] text-os-dim">recent runs</div>
                <div className="mt-1 space-y-0.5">
                  {runs.slice(0, 10).map((r) => (
                    <button key={r.id} onClick={() => openRun(r.id)} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-os-bg">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.status === 'success' ? 'bg-os-ok' : r.status === 'failed' || r.status === 'interrupted' ? 'bg-os-err' : r.status === 'running' ? 'bg-os-warn' : 'bg-os-dim'}`} />
                      <span className="truncate font-mono text-[9.5px] text-os-muted">v{r.workflowVersion} · {r.status}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
