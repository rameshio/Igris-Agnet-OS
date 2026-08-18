'use client';

/**
 * /flows workspace (Phase A): a list of workflows on the left, the typed canvas
 * on the right. Create a workflow, open it (loads its draft graph), edit, save,
 * publish. The knowledge graph on /brain is untouched — this is orchestration.
 *
 * Collapsible workspace (UX): the workflow list can collapse to a reopen tab and
 * the canvas can enter Focus Canvas (a full-viewport overlay). Both are pure
 * PRESENTATION state — they never save, publish, reload, or mutate the draft.
 * The FlowCanvas element keeps a stable position/key across these toggles so it
 * is never remounted (draft edits + React Flow viewport are preserved; React
 * Flow's own ResizeObserver handles the width change).
 */
import { useEffect, useState } from 'react';
import { Plus, Loader2, Workflow as WorkflowIcon, Pencil, Trash2, Check, X, PanelLeftClose, PanelLeft } from 'lucide-react';
import { FlowCanvas } from '@/components/flows/FlowCanvas';
import type { WorkflowGraph } from '@/lib/flows/schema';
import { FLOWS_LIST_COLLAPSE_KEY, serializeBoolPref, parseBoolPref } from '@/lib/layout-prefs';

type AgentOption = { id: string; name: string; model?: string };
type WorkflowListItem = { id: string; name: string; description: string; currentVersion: number | null; nodeCount: number; updatedAt: string };

const FOCUS_ATTR = 'data-flow-focus';

export function FlowWorkspace({ agents }: { agents: AgentOption[] }) {
  const [mounted, setMounted] = useState(false);
  const [list, setList] = useState<WorkflowListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<WorkflowListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // ── Presentation-only view state (collapsible workspace). Never touches graph.
  // Start expanded so the first client render matches the server (no hydration
  // mismatch), then hydrate the persisted preference after mount.
  const [listCollapsed, setListCollapsed] = useState(false);
  const [focus, setFocus] = useState(false); // session-only

  const selectedItem = list.find((w) => w.id === selected) ?? null;

  useEffect(() => {
    setMounted(true);
    try {
      setListCollapsed(parseBoolPref(localStorage.getItem(FLOWS_LIST_COLLAPSE_KEY)));
    } catch {
      /* storage unavailable — list stays expanded */
    }
  }, []);

  const setListCollapsedPref = (next: boolean) => {
    setListCollapsed(next);
    try {
      localStorage.setItem(FLOWS_LIST_COLLAPSE_KEY, serializeBoolPref(next));
    } catch {
      /* preferences are best-effort */
    }
  };

  // Focus Canvas: reflect on <html> (locks background scroll behind the overlay)
  // and wire Escape + Ctrl/Cmd+Shift+F. Always clean up so leaving /flows or the
  // component never strands the attribute.
  useEffect(() => {
    const root = document.documentElement;
    if (focus) root.setAttribute(FOCUS_ATTR, 'on');
    else root.removeAttribute(FOCUS_ATTR);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && focus) {
        setFocus(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        // Only meaningful with a canvas open.
        if (selected) {
          e.preventDefault();
          setFocus((f) => !f);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      root.removeAttribute(FOCUS_ATTR);
    };
  }, [focus, selected]);

  // A closed workflow can't be in focus.
  useEffect(() => {
    if (!selected && focus) setFocus(false);
  }, [selected, focus]);

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
    setRenaming(false);
    setNotice(null);
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

  const startRename = () => {
    if (!selectedItem) return;
    setRenameValue(selectedItem.name);
    setRenaming(true);
    setNotice(null);
  };
  const submitRename = async () => {
    const name = renameValue.trim();
    if (!selected || !name) return;
    setBusy(true);
    const res = await fetch(`/api/flows/${selected}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    setBusy(false);
    setRenaming(false);
    if (res?.ok) await loadList();
    else setNotice('Rename failed.');
  };

  // Delete the selected/confirmed workflow. The BACKEND decides delete vs archive
  // (history-safe) and tells us which happened; we surface it and never assume.
  const removeWorkflow = async (id: string) => {
    setBusy(true);
    setNotice(null);
    const res = await fetch(`/api/flows/${id}`, { method: 'DELETE' }).catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    setBusy(false);
    setConfirmDelete(null);
    if (!res?.ok) {
      setNotice(j?.error ?? 'Delete failed.');
      return;
    }
    const remaining = await loadList();
    setNotice(
      j?.mode === 'archived'
        ? 'Archived — this workflow had run/version history, so it was archived (audit preserved) instead of deleted.'
        : 'Workflow deleted.',
    );
    // Move selection safely off the removed workflow: next remaining, else empty.
    if (selected === id) {
      const next = remaining.find((w) => w.id !== id) ?? null;
      if (next) void open(next.id);
      else {
        setSelected(null);
        setGraph(null);
        setCurrentVersion(null);
      }
    }
  };

  const showList = !focus && !listCollapsed;
  const showReopenTab = !focus && listCollapsed;

  return (
    <div className="flex h-[calc(100vh-190px)] min-h-[540px] gap-4">
      {/* workflow list (hidden in focus; collapses to a reopen tab) */}
      {showList && (
        <aside key="list-panel" className="flex w-64 shrink-0 flex-col rounded-lg-t border border-os-border bg-os-surface p-3">
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
            <button
              onClick={() => setListCollapsedPref(true)}
              aria-label="Collapse workflow list"
              title="Collapse workflow list"
              className="flex h-[30px] w-[26px] shrink-0 items-center justify-center rounded border border-os-border text-os-muted hover:border-os-border-bright hover:text-os-text"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
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
      )}

      {/* collapsed workflow-list reopen tab */}
      {showReopenTab && (
        <button
          key="list-tab"
          onClick={() => setListCollapsedPref(false)}
          aria-label="Show workflow list"
          title="Show workflow list"
          className="flex w-9 shrink-0 flex-col items-center gap-2 rounded-lg-t border border-os-border bg-os-surface py-3 text-os-muted hover:border-os-border-bright hover:text-os-text"
        >
          <PanelLeft className="h-4 w-4" />
          <span className="[writing-mode:vertical-rl] rotate-180 font-mono text-[9px] uppercase tracking-[0.2em]">Workflows</span>
        </button>
      )}

      {/* canvas — same element/key in normal + focus, so FlowCanvas is never
          remounted (draft + viewport preserved). Focus = full-viewport overlay. */}
      <section
        key="canvas-section"
        className={
          focus
            ? 'fixed inset-0 z-50 flex flex-col bg-os-bg p-3'
            : 'flex min-w-0 flex-1 flex-col rounded-lg-t border border-os-border bg-os-surface p-3'
        }
      >
        {/* header: selected workflow name + Rename / Delete actions (not on the canvas itself) */}
        {selectedItem && (
          <div className="mb-2 flex items-center gap-2 border-b border-os-border pb-2">
            {renaming ? (
              <div className="flex flex-1 items-center gap-1.5">
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitRename();
                    if (e.key === 'Escape') setRenaming(false);
                  }}
                  className="min-w-0 flex-1 rounded border border-os-border bg-os-bg px-2 py-1 text-[12px] font-bold text-os-text focus:border-os-border-bright focus:outline-none"
                />
                <button onClick={submitRename} disabled={busy || !renameValue.trim()} aria-label="Save name" className="rounded border border-os-border-bright px-1.5 py-1 text-os-ok hover:bg-os-bg disabled:opacity-50">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                </button>
                <button onClick={() => setRenaming(false)} aria-label="Cancel rename" className="rounded border border-os-border px-1.5 py-1 text-os-dim hover:text-os-text"><X className="h-3.5 w-3.5" /></button>
              </div>
            ) : (
              <>
                {focus && (
                  <span className="rounded border border-os-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-os-dim">focus</span>
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-os-text">{selectedItem.name}</span>
                <button onClick={startRename} className="flex items-center gap-1 rounded border border-os-border px-2 py-1 text-[10.5px] text-os-muted hover:border-os-border-bright hover:text-os-text">
                  <Pencil className="h-3 w-3" /> Rename
                </button>
                <button onClick={() => { setConfirmDelete(selectedItem); setNotice(null); }} className="flex items-center gap-1 rounded border border-os-err/50 px-2 py-1 text-[10.5px] text-os-err hover:bg-os-err/10">
                  <Trash2 className="h-3 w-3" /> Delete
                </button>
              </>
            )}
          </div>
        )}

        {notice && (
          <p className="mb-2 flex items-center gap-1.5 font-mono text-[10.5px] text-os-muted">
            {notice}
            <button onClick={() => setNotice(null)} className="text-os-dim hover:text-os-text"><X className="h-3 w-3" /></button>
          </p>
        )}

        <div className="min-h-0 flex-1">
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
              focusMode={focus}
              onToggleFocus={() => setFocus((f) => !f)}
              onPublished={(v) => {
                setCurrentVersion(v);
                void loadList();
              }}
            />
          )}
        </div>
      </section>

      {/* Delete confirmation — shows the workflow name; deletion is never one-click. */}
      {confirmDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => !busy && setConfirmDelete(null)}>
          <div className="w-full max-w-sm rounded-lg-t border border-os-border-bright bg-os-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-[13px] font-bold text-os-text">Delete workflow “{confirmDelete.name}”?</div>
            <p className="mt-1.5 font-mono text-[10.5px] text-os-muted">
              This cannot be undone. If this workflow has published versions or run history, it will be <b>archived</b> (audit preserved) instead of hard-deleted.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)} disabled={busy} className="rounded border border-os-border px-3 py-1.5 text-[11px] text-os-muted hover:text-os-text disabled:opacity-50">Cancel</button>
              <button onClick={() => removeWorkflow(confirmDelete.id)} disabled={busy} className="flex items-center gap-1.5 rounded border border-os-err/60 bg-os-err/10 px-3 py-1.5 text-[11px] font-semibold text-os-err hover:bg-os-err/20 disabled:opacity-50">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
