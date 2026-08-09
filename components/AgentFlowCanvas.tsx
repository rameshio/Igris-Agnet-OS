'use client';

/**
 * Agent Flow — a drag-and-connect canvas of agents. Drag nodes, draw an edge
 * from one agent to another (source hands its output to the target), then Run:
 * the flow executes in dependency order, chaining outputs through G-Brain, and
 * each node lights up with its result. Save persists the canvas.
 *
 * React Flow powers the interaction; the nodes are styled to match the app's
 * terminal graph. Rendered after mount to stay clear of SSR.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Play, Save, Plus, Loader2, Check, Pencil, X, ExternalLink, Copy, Trash2 } from 'lucide-react';

type AgentOption = { id: string; name: string; departmentId: string; instructions?: string };
type FlowNodeData = { label: string; agentId: string; status: 'idle' | 'running' | 'ok' | 'fail'; output?: string };
type FlowNode = Node<FlowNodeData>;

type SavedFlow = {
  nodes: { id: string; agentId: string; x: number; y: number }[];
  edges: { id: string; source: string; target: string }[];
};

const STATUS_DOT: Record<FlowNodeData['status'], string> = {
  idle: 'bg-os-dim',
  running: 'bg-os-warn animate-pulse',
  ok: 'bg-os-ok',
  fail: 'bg-os-err',
};

function AgentNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <div
      className={`min-w-[150px] rounded-md border bg-os-surface px-3 py-2 shadow-sm ${
        selected ? 'border-os-accent' : 'border-os-border'
      }`}
      title={data.output}
    >
      <Handle type="target" position={Position.Left} style={{ background: 'var(--accent)', width: 8, height: 8 }} />
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[data.status]}`} />
        <span className="truncate text-[12px] font-bold text-os-text">{data.label}</span>
      </div>
      {data.output && (
        <div className="mt-1 line-clamp-2 font-mono text-[9px] leading-snug text-os-muted">{data.output}</div>
      )}
      <Handle type="source" position={Position.Right} style={{ background: 'var(--accent)', width: 8, height: 8 }} />
    </div>
  );
}

const nodeTypes = { agent: AgentNode };
const uid = () => `n-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

type AgentMeta = { name: string; instructions: string };

export function AgentFlowCanvas({ agents, initialFlow }: { agents: AgentOption[]; initialFlow: SavedFlow }) {
  // Live copy of each agent's editable fields — seeded from props, then kept in
  // sync as the user edits a node inline (so labels update without a reload).
  const [meta, setMeta] = useState<Map<string, AgentMeta>>(
    () => new Map(agents.map((a) => [a.id, { name: a.name, instructions: a.instructions ?? '' }])),
  );
  const nameOf = useMemo(() => new Map([...meta].map(([id, m]) => [id, m.name])), [meta]);
  // The palette is state so Duplicate can add a new agent without a reload.
  const [palette, setPalette] = useState<AgentOption[]>(agents);
  const [runningId, setRunningId] = useState<string | null>(null);

  const seededNodes: FlowNode[] = useMemo(
    () =>
      initialFlow.nodes.map((n) => ({
        id: n.id,
        type: 'agent',
        position: { x: n.x, y: n.y },
        data: { label: nameOf.get(n.agentId) ?? n.agentId, agentId: n.agentId, status: 'idle' },
      })),
    [initialFlow, nameOf],
  );
  const seededEdges: Edge[] = useMemo(
    () => initialFlow.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: true })),
    [initialFlow],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(seededNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(seededEdges);
  const [mounted, setMounted] = useState(false);
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [seed, setSeed] = useState(''); // starting input fed to the first agent(s)
  // Click a node → select it (shows a small action menu). Edit opens the form.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menuMsg, setMenuMsg] = useState<string | null>(null); // inline feedback in the menu
  const [armedDelete, setArmedDelete] = useState(false); // two-step delete confirm
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editInstr, setEditInstr] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  useEffect(() => setMounted(true), []);

  const openEditor = useCallback(
    (agentId: string) => {
      const m = meta.get(agentId);
      setSelectedId(null);
      setEditId(agentId);
      setEditName(m?.name ?? agentId);
      setEditInstr(m?.instructions ?? '');
      setEditErr(null);
    },
    [meta],
  );

  const saveEdit = async () => {
    if (!editId) return;
    setSavingEdit(true);
    setEditErr(null);
    const res = await fetch(`/api/agents/${editId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editName.trim(), instructions: editInstr.trim() }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    setSavingEdit(false);
    if (!res?.ok || !json?.agent) {
      setEditErr(json?.error ?? 'Save failed — is this a custom agent?');
      return;
    }
    // Reflect the change everywhere: meta map, node labels on the canvas.
    setMeta((prev) => new Map(prev).set(editId, { name: json.agent.name, instructions: json.agent.instructions }));
    setNodes((ns) =>
      ns.map((n) => (n.data.agentId === editId ? { ...n, data: { ...n.data, label: json.agent.name } } : n)),
    );
    setEditId(null);
  };

  // Run one agent on its own (independent of the flow). ~40s on Hermes.
  const runAgent = async (agentId: string) => {
    setRunningId(agentId);
    setMenuMsg(`Running ${nameOf.get(agentId) ?? agentId}… ~40s on Hermes.`);
    const res = await fetch(`/api/agents/${agentId}/run`, { method: 'POST' }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    setRunningId(null);
    if (!res?.ok || !json?.run) {
      setMenuMsg(json?.error ?? 'Run failed.');
      return;
    }
    const out = json.run.output ?? json.run.summary ?? '';
    setMenuMsg(`✓ Ran. ${typeof out === 'string' ? out.slice(0, 160) : 'See /agents for output.'}`.trim());
  };

  // Remove the agent's node(s) + touching edges FROM THE CANVAS only — the
  // agent itself is untouched (still on /agents, still runnable). This is the
  // safe default; permanent deletion is the separate, clearly-labeled action.
  const removeFromCanvas = (agentId: string) => {
    const removedNodeIds = new Set(nodes.filter((n) => n.data.agentId === agentId).map((n) => n.id));
    if (removedNodeIds.size === 0) {
      setMenuMsg('That agent has no node on the canvas.');
      return;
    }
    setNodes((ns) => ns.filter((n) => n.data.agentId !== agentId));
    setEdges((es) => es.filter((e) => !removedNodeIds.has(e.source) && !removedNodeIds.has(e.target)));
    setSelectedId(null);
    setSaved(false);
    setMenuMsg(`Removed “${nameOf.get(agentId) ?? agentId}” from the canvas — the agent is kept. Save to persist the flow.`);
  };

  // PERMANENTLY delete a custom agent everywhere (DB + /agents + canvas). This is
  // destructive; the inline two-step button is the confirmation.
  const deleteAgent = async (agentId: string) => {
    setMenuMsg('Deleting…');
    const res = await fetch(`/api/agents/${agentId}`, { method: 'DELETE' }).catch(() => null);
    if (!res?.ok) {
      setMenuMsg('Delete failed — only custom agents can be removed.');
      return;
    }
    const removedNodeIds = new Set(nodes.filter((n) => n.data.agentId === agentId).map((n) => n.id));
    setNodes((ns) => ns.filter((n) => n.data.agentId !== agentId));
    setEdges((es) => es.filter((e) => !removedNodeIds.has(e.source) && !removedNodeIds.has(e.target)));
    setPalette((p) => p.filter((a) => a.id !== agentId));
    setMeta((m) => {
      const next = new Map(m);
      next.delete(agentId);
      return next;
    });
    setArmedDelete(false);
    setSelectedId(null);
    setSaved(false);
  };

  // Duplicate a custom agent (copies name/instructions/tools/model), add it to
  // the palette AND drop it as a node on the canvas so the result is visible.
  const duplicateAgent = async (agentId: string) => {
    setMenuMsg('Duplicating…');
    const listRes = await fetch('/api/agents').catch(() => null);
    const list = listRes ? await listRes.json().catch(() => null) : null;
    const src = list?.customAgents?.find((a: { id: string }) => a.id === agentId);
    if (!src) {
      setMenuMsg('Could not load the agent to duplicate.');
      return;
    }
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${src.name} (copy)`,
        departmentId: src.departmentId,
        instructions: src.instructions,
        tools: src.tools ?? [],
        model: src.model ?? '',
        enabled: true,
      }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    if (!res?.ok || !json?.agent) {
      setMenuMsg(json?.error ?? 'Duplicate failed.');
      return;
    }
    const a = json.agent;
    setPalette((p) => [...p, { id: a.id, name: a.name, departmentId: a.departmentId, instructions: a.instructions }]);
    setMeta((m) => new Map(m).set(a.id, { name: a.name, instructions: a.instructions }));
    setNodes((ns) => [
      ...ns,
      {
        id: uid(),
        type: 'agent',
        position: { x: 60 + (ns.length % 4) * 190, y: 60 + Math.floor(ns.length / 4) * 120 },
        data: { label: a.name, agentId: a.id, status: 'idle' },
      },
    ]);
    setMenuMsg(`✓ Duplicated as "${a.name}" — added to the canvas.`);
  };

  const onConnect = useCallback(
    (c: Connection) => setEdges((eds) => addEdge({ ...c, animated: true, id: uid() }, eds)),
    [setEdges],
  );

  const addAgent = (agentId: string) => {
    setNodes((ns) => [
      ...ns,
      {
        id: uid(),
        type: 'agent',
        position: { x: 40 + (ns.length % 4) * 190, y: 40 + Math.floor(ns.length / 4) * 120 },
        data: { label: nameOf.get(agentId) ?? agentId, agentId, status: 'idle' },
      },
    ]);
    setSaved(false);
  };

  const save = async () => {
    const payload = {
      id: 'main',
      name: 'Agent Flow',
      nodes: nodes.map((n) => ({ id: n.id, agentId: n.data.agentId, x: Math.round(n.position.x), y: Math.round(n.position.y) })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    };
    const res = await fetch('/api/agent-flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => null);
    if (res?.ok) setSaved(true);
  };

  const run = async () => {
    if (nodes.length === 0) {
      setNote('Add at least one agent to the canvas first.');
      return;
    }
    setRunning(true);
    setNote(null);
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: 'running', output: undefined } })));
    const res = await fetch('/api/agent-flows/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodes: nodes.map((n) => ({ id: n.id, agentId: n.data.agentId })),
        edges: edges.map((e) => ({ source: e.source, target: e.target })),
        initialInput: seed.trim() || undefined,
      }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    setRunning(false);
    if (!json || !Array.isArray(json.steps)) {
      setNote('The flow run failed. Is a brain connected (Settings → Brain)?');
      setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: 'idle' } })));
      return;
    }
    const byNode = new Map<string, { ok: boolean; output: string }>(json.steps.map((s: any) => [s.nodeId, s]));
    setNodes((ns) =>
      ns.map((n) => {
        const s = byNode.get(n.id);
        return { ...n, data: { ...n.data, status: s ? (s.ok ? 'ok' : 'fail') : 'idle', output: s?.output } };
      }),
    );
    setNote(json.detail ?? 'Flow complete.');
  };

  const btn =
    'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-50';

  return (
    <section className="rounded-lg-t border border-os-border bg-os-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.26em] text-os-dim">// agent flow</div>
          <h2 className="mt-1 text-[15px] font-bold">Wire your agents together</h2>
          <p className="mt-0.5 text-[11.5px] text-os-muted">
            Add agents, drag to connect them (output → input), then run the chain. Click a node for options (Edit). Each step is saved to G-Brain.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={save} className={`${btn} border-os-border text-os-muted hover:text-os-text`}>
            {saved ? <Check className="h-3.5 w-3.5 text-os-ok" /> : <Save className="h-3.5 w-3.5" />} Save
          </button>
          <button
            onClick={run}
            disabled={running}
            className={`${btn} border-os-border-bright bg-os-text text-os-bg hover:opacity-90`}
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Run flow
          </button>
        </div>
      </div>

      {/* starting input — fed to the flow's first agent(s), e.g. a job posting */}
      <textarea
        value={seed}
        onChange={(e) => setSeed(e.target.value)}
        placeholder="Starting input for the flow — e.g. paste a job posting here…"
        rows={2}
        className="mt-3 w-full resize-y rounded border border-os-border bg-os-bg px-2 py-1.5 text-[11.5px] leading-relaxed text-os-text placeholder:text-os-dim focus:border-os-border-bright focus:outline-none"
      />

      {/* agent palette */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {palette.length === 0 && <span className="font-mono text-[10px] text-os-dim">No agents yet — create one on /agents first.</span>}
        {palette.map((a) => (
          <button
            key={a.id}
            onClick={() => addAgent(a.id)}
            className="flex items-center gap-1 rounded border border-os-border bg-os-bg px-2 py-1 text-[10.5px] text-os-muted hover:border-os-border-bright hover:text-os-text"
          >
            <Plus className="h-3 w-3" /> {a.name}
          </button>
        ))}
      </div>

      {note && <p className="mt-2 font-mono text-[10.5px] text-os-muted">{note}</p>}
      {running && (
        <p className="mt-1 font-mono text-[10px] text-os-dim">Running the chain… with Hermes as the brain each step is ~40s.</p>
      )}

      {/* Node action menu — Edit · Run · Duplicate · Remove (canvas only) · Delete agent (everywhere) */}
      {selectedId && !editId && (
        <div className="mt-3 rounded-md border border-os-border-bright bg-os-bg px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="truncate text-[11.5px] font-bold text-os-text">{nameOf.get(selectedId) ?? selectedId}</span>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => openEditor(selectedId)} className={`${btn} border-os-border-bright bg-os-text text-os-bg hover:opacity-90`}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
              <button
                onClick={() => runAgent(selectedId)}
                disabled={runningId === selectedId}
                className={`${btn} border-os-border text-os-muted hover:text-os-text`}
              >
                {runningId === selectedId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Run
              </button>
              <button onClick={() => duplicateAgent(selectedId)} className={`${btn} border-os-border text-os-muted hover:text-os-text`}>
                <Copy className="h-3.5 w-3.5" /> Duplicate
              </button>
              {/* Safe default: take the node off the canvas, keep the agent */}
              <button onClick={() => removeFromCanvas(selectedId)} className={`${btn} border-os-border text-os-muted hover:text-os-text`}>
                <X className="h-3.5 w-3.5" /> Remove
              </button>
              {/* Destructive: delete the agent everywhere */}
              {armedDelete ? (
                <button onClick={() => deleteAgent(selectedId)} className={`${btn} border-os-err bg-os-err text-os-bg hover:opacity-90`}>
                  <Trash2 className="h-3.5 w-3.5" /> Confirm delete everywhere
                </button>
              ) : (
                <button onClick={() => setArmedDelete(true)} className={`${btn} border-os-border text-os-err hover:opacity-90`}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete agent
                </button>
              )}
              <button onClick={() => setSelectedId(null)} className="text-os-muted hover:text-os-text" aria-label="Close menu">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          {(menuMsg || armedDelete) && (
            <p className="mt-1.5 font-mono text-[10.5px] text-os-muted">
              {armedDelete
                ? '⚠ “Delete agent” removes it permanently from everywhere (not just the canvas). Click “Confirm delete everywhere”, or ✕ to cancel. To only take it off the canvas, use Remove.'
                : menuMsg}
            </p>
          )}
        </div>
      )}

      {/* Inline agent editor — opens when Edit is chosen */}
      {editId && (
        <div className="mt-3 rounded-md border border-os-border-bright bg-os-bg p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-os-text">
              <Pencil className="h-3.5 w-3.5" /> Edit agent
            </div>
            <div className="flex items-center gap-2">
              <a
                href="/agents"
                className="flex items-center gap-1 text-[10px] text-os-muted hover:text-os-text"
              >
                <ExternalLink className="h-3 w-3" /> Full editor
              </a>
              <button onClick={() => setEditId(null)} className="text-os-muted hover:text-os-text" aria-label="Close editor">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <label className="mt-2 block text-[9px] uppercase tracking-[0.2em] text-os-dim">Name</label>
          <input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="mt-1 w-full rounded border border-os-border bg-os-surface px-2 py-1.5 text-[12px] text-os-text focus:border-os-border-bright focus:outline-none"
          />
          <label className="mt-2 block text-[9px] uppercase tracking-[0.2em] text-os-dim">Instructions (system prompt)</label>
          <textarea
            value={editInstr}
            onChange={(e) => setEditInstr(e.target.value)}
            rows={5}
            className="mt-1 w-full resize-y rounded border border-os-border bg-os-surface px-2 py-1.5 text-[11.5px] leading-relaxed text-os-text focus:border-os-border-bright focus:outline-none"
          />
          {editErr && <p className="mt-1.5 font-mono text-[10.5px] text-os-err">{editErr}</p>}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={saveEdit}
              disabled={savingEdit || !editName.trim() || !editInstr.trim()}
              className={`${btn} border-os-border-bright bg-os-text text-os-bg hover:opacity-90`}
            >
              {savingEdit ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save agent
            </button>
            <button onClick={() => setEditId(null)} className={`${btn} border-os-border text-os-muted hover:text-os-text`}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 h-[520px] w-full overflow-hidden rounded-md border border-os-border bg-os-bg">
        {mounted ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => {
              setSelectedId((node.data as FlowNodeData).agentId);
              setEditId(null);
              setMenuMsg(null);
              setArmedDelete(false);
            }}
            nodeTypes={nodeTypes}
            fitView
            colorMode="system"
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} size={1} color="var(--border-strong)" />
            <MiniMap pannable zoomable className="!bg-os-surface2" />
            <Controls showInteractive={false} />
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-[11px] text-os-dim">Loading canvas…</div>
        )}
      </div>
    </section>
  );
}
