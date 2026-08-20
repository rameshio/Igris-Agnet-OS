'use client';

/**
 * G-Brain workspace (Architecture V2 · F4) — the [Radial][Neural] tabbed structural view
 * over the canonical G-Brain. Radial is active (F4): search/deep-link to a root, click nodes
 * to inspect via the Universal Inspector, double-click to focus (re-root). Neural is an
 * honest F5 placeholder — selection is preserved across the switch so F5 can reuse it.
 *
 * Deep-link: `/brain?entity=<kind:id|bent-…>`. The initial render is deterministic (empty);
 * the URL is read in a mount effect (SSR/hydration-safe, per U1/U6). React never touches
 * SQLite; every read is a bounded API call, and mutating actions route to existing endpoints.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RadialGraph } from '@/lib/brain/projection/model';
import type { InspectorAction, InspectorView } from '@/lib/brain/inspector/model';
import type { BrainSearchHit } from '@/lib/brain/core/search';
import { BrainRadial } from '@/components/BrainRadial';
import { UniversalInspector } from '@/components/UniversalInspector';
import { SectionHead } from '@/components/terminal';

const INSPECTABLE = new Set(['agent', 'mission', 'company_task', 'artifact', 'knowledge', 'workflow', 'source', 'approval']);

/** A radial node id is `keyKind:id`; map it to an Inspector {kind,id} (company_task → task). */
function inspectTarget(nodeId: string): { kind: string; id: string } | null {
  const i = nodeId.indexOf(':');
  if (i < 0) return null;
  const keyKind = nodeId.slice(0, i);
  const id = nodeId.slice(i + 1);
  if (!INSPECTABLE.has(keyKind)) return null;
  return { kind: keyKind === 'company_task' ? 'task' : keyKind, id };
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export function BrainWorkspace() {
  const router = useRouter();
  const [tab, setTab] = useState<'radial' | 'neural'>('radial');
  const [root, setRoot] = useState<string | null>(null);
  const [graph, setGraph] = useState<RadialGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<InspectorView | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<BrainSearchHit[] | null>(null);

  const loadRadial = useCallback(async (entity: string) => {
    setGraphLoading(true);
    const g = await getJson<RadialGraph>(`/api/brain/radial?entity=${encodeURIComponent(entity)}&depth=1`);
    setGraphLoading(false);
    if (g && 'nodes' in g) {
      setGraph(g);
      setError(null);
    } else {
      setError('Could not load that entity.');
    }
  }, []);

  const focus = useCallback(
    (entity: string) => {
      setRoot(entity);
      setSelectedId(entity);
      setHits(null);
      if (typeof window !== 'undefined') window.history.replaceState(null, '', `/brain?entity=${encodeURIComponent(entity)}`);
      void loadRadial(entity);
    },
    [loadRadial],
  );

  // Hydrate the root from the URL on mount (deterministic first render → no hydration mismatch).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const entity = new URLSearchParams(window.location.search).get('entity');
    if (entity) focus(entity);
  }, [focus]);

  const selectNode = useCallback(async (nodeId: string) => {
    setSelectedId(nodeId);
    const target = inspectTarget(nodeId);
    if (!target) {
      setView(null);
      return;
    }
    setViewLoading(true);
    const res = await getJson<{ view: InspectorView }>(`/api/brain/inspect?kind=${target.kind}&id=${encodeURIComponent(target.id)}`);
    setViewLoading(false);
    setView(res?.view ?? null);
  }, []);

  const runSearch = async () => {
    if (!query.trim()) return setHits(null);
    const res = await getJson<{ results: BrainSearchHit[] }>(`/api/brain/search?q=${encodeURIComponent(query.trim())}`);
    setHits(res?.results ?? []);
  };

  const runAction = async (action: InspectorAction) => {
    if (action.kind === 'navigate') {
      router.push(action.href);
      return;
    }
    // api action — confirm, then call the EXISTING endpoint (never a new mutation path).
    if (typeof window !== 'undefined' && !window.confirm(`${action.label}?`)) return;
    setBusy(true);
    try {
      await fetch(action.path, { method: action.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action.body ?? {}) });
    } finally {
      setBusy(false);
    }
    if (selectedId) await selectNode(selectedId);
    if (root) await loadRadial(root);
  };

  return (
    <section className="rounded-lg-t border border-os-border bg-os-surface p-5">
      <SectionHead label="G-Brain · Structure" />
      <div className="mb-3 mt-1 flex flex-wrap items-center gap-2">
        {(['radial', 'neural'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            aria-pressed={tab === v}
            className={`rounded-sm-t border px-2.5 py-1 font-mono text-[10.5px] uppercase transition-colors ${tab === v ? 'border-os-accent text-os-accent' : 'border-os-border text-os-dim hover:text-os-muted'}`}
          >
            {v}
          </button>
        ))}
        <div className="ml-auto flex min-w-[220px] flex-1 gap-1.5 sm:max-w-[360px]">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            placeholder="Search company brain…"
            className="min-w-0 flex-1 rounded border border-os-border bg-os-bg px-2 py-1 font-mono text-[10.5px] text-os-text placeholder:text-os-dim"
          />
          <button onClick={runSearch} className="shrink-0 rounded border border-os-border-strong px-2 py-1 font-mono text-[9.5px] uppercase text-os-muted hover:text-os-text">Find</button>
        </div>
      </div>

      {error && <div className="mb-2 rounded border border-os-err/50 bg-os-err/5 px-3 py-1.5 font-mono text-[10px] text-os-err">⚠ {error}</div>}

      {hits !== null && (
        <div className="mb-3 rounded-sm-t border border-os-border bg-os-bg p-2">
          {hits.length === 0 ? (
            <span className="font-mono text-[10px] text-os-dim">No matches.</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {hits.map((h) => (
                <button key={`${h.kind}:${h.id}`} onClick={() => focus(h.id)} className="rounded border border-os-border px-2 py-0.5 font-mono text-[9.5px] text-os-muted hover:border-os-accent/50 hover:text-os-accent">
                  <span className="uppercase text-os-dim">{h.kind}</span> {h.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'radial' ? (
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="min-w-0 flex-1">
            <BrainRadial graph={graph} loading={graphLoading} selectedId={selectedId} onSelect={(id) => void selectNode(id)} onFocus={focus} />
            <p className="mt-1 font-mono text-[9px] text-os-dim">Solid edge = persisted G-Brain relationship · dashed = live projection from canonical systems (never persisted).</p>
          </div>
          <UniversalInspector view={view} loading={viewLoading} busy={busy} onAction={runAction} />
        </div>
      ) : (
        <div className="flex items-center justify-center rounded-sm-t border border-dashed border-os-border bg-os-bg" style={{ height: 320 }}>
          <div className="text-center">
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-os-dim">Neural — operational graph</div>
            <p className="mt-2 max-w-md font-mono text-[10px] text-os-dim">F5 (live execution flow / company events) is not implemented yet. Company events remain the operational ledger; they are not piped into the brain. Your selection is preserved here for when Neural lands.</p>
            {selectedId && <p className="mt-2 font-mono text-[9.5px] text-os-muted">selected: {selectedId}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
