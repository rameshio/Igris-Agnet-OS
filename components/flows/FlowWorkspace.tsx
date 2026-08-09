'use client';

/**
 * /flows workspace (Phase A): a list of workflows on the left, the typed canvas
 * on the right. Create a workflow, open it (loads its draft graph), edit, save,
 * publish. The knowledge graph on /brain is untouched — this is orchestration.
 */
import { useEffect, useState } from 'react';
import { Plus, Loader2, Workflow as WorkflowIcon } from 'lucide-react';
import { FlowCanvas } from '@/components/flows/FlowCanvas';
import type { WorkflowGraph } from '@/lib/flows/schema';

type AgentOption = { id: string; name: string; model?: string };
type WorkflowListItem = { id: string; name: string; description: string; currentVersion: number | null; nodeCount: number; updatedAt: string };

export function FlowWorkspace({ agents }: { agents: AgentOption[] }) {
  const [mounted, setMounted] = useState(false);
  const [list, setList] = useState<WorkflowListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => setMounted(true), []);

  const loadList = async () => {
    const res = await fetch('/api/flows').catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    if (j?.workflows) setList(j.workflows);
    return (j?.workflows ?? []) as WorkflowListItem[];
  };
  useEffect(() => {
    void loadList();
  }, []);

  const open = async (id: string) => {
    setSelected(id);
    setGraph(null);
    setLoading(true);
    const res = await fetch(`/api/flows/${id}`).catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    setLoading(false);
    if (j?.graph) setGraph(j.graph as WorkflowGraph);
    setCurrentVersion(j?.workflow?.currentVersion ?? null);
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    const res = await fetch('/api/flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    setCreating(false);
    setNewName('');
    await loadList();
    if (j?.workflow?.id) void open(j.workflow.id);
  };

  return (
    <div className="flex h-[calc(100vh-190px)] min-h-[540px] gap-4">
      {/* workflow list */}
      <aside className="flex w-64 shrink-0 flex-col rounded-lg-t border border-os-border bg-os-surface p-3">
        <div className="flex items-center gap-1.5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            placeholder="New workflow name…"
            className="min-w-0 flex-1 rounded border border-os-border bg-os-bg px-2 py-1.5 text-[11.5px] text-os-text placeholder:text-os-dim focus:border-os-border-bright focus:outline-none"
          />
          <button
            onClick={create}
            disabled={creating || !newName.trim()}
            aria-label="Create workflow"
            className="flex shrink-0 items-center rounded border border-os-border-bright bg-os-text px-2 py-1.5 text-os-bg hover:opacity-90 disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          </button>
        </div>

        <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">
          {list.length === 0 && <p className="px-1 font-mono text-[10.5px] text-os-dim">No workflows yet. Create one above.</p>}
          {list.map((w) => (
            <button
              key={w.id}
              onClick={() => open(w.id)}
              className={`block w-full rounded-md border px-2.5 py-2 text-left transition-colors ${
                selected === w.id ? 'border-os-border-bright bg-os-bg' : 'border-transparent hover:bg-os-bg'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <WorkflowIcon className="h-3 w-3 shrink-0 text-os-muted" />
                <span className="truncate text-[12px] font-bold text-os-text">{w.name}</span>
              </div>
              <div className="mt-0.5 font-mono text-[9px] text-os-dim">
                {w.nodeCount} node{w.nodeCount === 1 ? '' : 's'} · {w.currentVersion ? `v${w.currentVersion}` : 'draft'}
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* canvas */}
      <section className="min-w-0 flex-1 rounded-lg-t border border-os-border bg-os-surface p-3">
        {!selected ? (
          <div className="flex h-full items-center justify-center text-center font-mono text-[11px] text-os-dim">
            Select a workflow, or create one, to open the canvas.
          </div>
        ) : loading || !graph || !mounted ? (
          <div className="flex h-full items-center justify-center font-mono text-[11px] text-os-dim">Loading workflow…</div>
        ) : (
          <FlowCanvas
            key={selected}
            workflowId={selected}
            initialGraph={graph}
            agents={agents}
            currentVersion={currentVersion}
            onPublished={(v) => {
              setCurrentVersion(v);
              void loadList();
            }}
          />
        )}
      </section>
    </div>
  );
}
