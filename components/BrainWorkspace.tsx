'use client';

/**
 * G-Brain workspace (Architecture V2 · consolidation) — the ONE brain. The original
 * attractive radial + neural renderers (KnowledgeGraph / NeuralGraph) are the visual
 * shell; their data is now CANONICAL (structural = company→missions→tasks→agents→
 * artifacts/knowledge · operational = the read-only F5 projection over company_events).
 *
 * This component is the CONTROLLER: it owns the [Radial][Neural] tab, fetches the
 * bounded canonical graph, threads selection into the ONE Universal Inspector, runs
 * G-Brain search, and honours the `?entity=` deep-link as a FOCUS on the same brain.
 * Opening `/brain` with no entity shows a bounded company-wide overview (never blank).
 * React never touches SQLite; every read is a bounded API call.
 */
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { KnowledgeGraph as KGData } from '@/lib/knowledge-graph';
import type { InspectorAction, InspectorView } from '@/lib/brain/inspector/model';
import type { BrainSearchHit } from '@/lib/brain/core/search';
import { inspectTargetForKgId } from '@/lib/brain/kg-ids';
import { UniversalInspector } from '@/components/UniversalInspector';
import { SectionHead } from '@/components/terminal';

type CompanyBrainGraph = { graph: KGData; focusNodeId?: string; generatedAt?: string; truncated?: boolean };

const NEURAL_POLL_MS = 5000;
const NEURAL_WINDOW_OPTIONS = ['15m', '1h', '6h', '24h'] as const;
// Operational relabelling of the legacy neural stage cards (org → operational meaning).
const NEURAL_LAYER_NAMES = { tool: 'ARTIFACTS · RUNS', worker: 'AGENTS', task: 'TASKS', team: 'MISSIONS', self: '' } as const;

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

const RADIAL_SKELETON = (
  <div className="flex flex-col gap-3 lg:flex-row">
    <div className="h-[680px] min-w-0 flex-1 animate-pulse rounded-lg-t border border-os-border bg-os-surface" />
    <div className="hidden shrink-0 rounded-lg-t border border-os-border bg-os-surface lg:block lg:h-[680px] lg:w-72" />
  </div>
);
const NEURAL_SKELETON = <div className="w-full animate-pulse overflow-hidden rounded-lg-t border border-os-border bg-os-surface" style={{ aspectRatio: '1200 / 640' }} />;

const KnowledgeGraph = dynamic(() => import('@/components/KnowledgeGraph').then((m) => m.KnowledgeGraph), { ssr: false, loading: () => RADIAL_SKELETON });
const NeuralGraph = dynamic(() => import('@/components/NeuralGraph').then((m) => m.NeuralGraph), { ssr: false, loading: () => NEURAL_SKELETON });

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
  const [structural, setStructural] = useState<CompanyBrainGraph | null>(null);
  const [operational, setOperational] = useState<CompanyBrainGraph | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<InspectorView | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<BrainSearchHit[] | null>(null);
  const [neuralWindow, setNeuralWindow] = useState<string>('1h');
  const neuralInFlight = useRef(false);

  const loadStructural = useCallback(async (entity: string | null): Promise<CompanyBrainGraph | null> => {
    const q = entity ? `?entity=${encodeURIComponent(entity)}` : '';
    const g = await getJson<CompanyBrainGraph>(`/api/brain/company-graph${q}`);
    if (g && 'graph' in g) {
      setStructural(g);
      setError(null);
      return g;
    }
    setError('Could not load the company brain.');
    return null;
  }, []);

  const loadOperational = useCallback(async (entity: string | null) => {
    if (neuralInFlight.current) return; // no-overlap guard
    neuralInFlight.current = true;
    try {
      const params = new URLSearchParams({ mode: 'operational', window: neuralWindow });
      if (entity) params.set('entity', entity);
      const g = await getJson<CompanyBrainGraph>(`/api/brain/company-graph?${params.toString()}`);
      if (g && 'graph' in g) setOperational(g);
    } finally {
      neuralInFlight.current = false;
    }
  }, [neuralWindow]);

  const selectNode = useCallback(async (nodeId: string) => {
    setSelectedId(nodeId);
    const target = inspectTargetForKgId(nodeId);
    if (!target) {
      setView(null);
      return;
    }
    setViewLoading(true);
    const res = await getJson<{ view: InspectorView }>(`/api/brain/inspect?kind=${target.kind}&id=${encodeURIComponent(target.id)}`);
    setViewLoading(false);
    setView(res?.view ?? null);
  }, []);

  const focus = useCallback(
    async (entity: string) => {
      setRoot(entity);
      setHits(null);
      if (typeof window !== 'undefined') window.history.replaceState(null, '', `/brain?entity=${encodeURIComponent(entity)}`);
      const g = await loadStructural(entity);
      void loadOperational(entity);
      // The builder returns the focused entity's KG node id — open the ONE Inspector on it.
      if (g?.focusNodeId) void selectNode(g.focusNodeId);
    },
    [loadStructural, loadOperational, selectNode],
  );

  // Initial load: honour the ?entity= deep-link (focus) or show the company-wide overview.
  useEffect(() => {
    const entity = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('entity') : null;
    if (entity) focus(entity);
    else void loadStructural(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll the operational projection only while the Neural tab is active.
  useEffect(() => {
    if (tab !== 'neural') return;
    void loadOperational(root);
    const id = setInterval(() => void loadOperational(root), NEURAL_POLL_MS);
    return () => clearInterval(id);
  }, [tab, root, loadOperational]);

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
    if (typeof window !== 'undefined' && !window.confirm(`${action.label}?`)) return;
    setBusy(true);
    try {
      await fetch(action.path, { method: action.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action.body ?? {}) });
    } finally {
      setBusy(false);
    }
    if (selectedId) await selectNode(selectedId);
    await loadStructural(root);
  };

  return (
    <section className="rounded-lg-t border border-os-border bg-os-surface p-5">
      <SectionHead label="G-Brain" />
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
        {root && (
          <button onClick={() => { setRoot(null); void loadStructural(null); if (typeof window !== 'undefined') window.history.replaceState(null, '', '/brain'); }} className="rounded-sm-t border border-os-border px-2 py-1 font-mono text-[9.5px] uppercase text-os-dim hover:text-os-accent">
            ↺ overview
          </button>
        )}
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
                <button key={`${h.kind}:${h.id}`} onClick={() => focus(`${h.kind}:${h.id}`)} className="rounded border border-os-border px-2 py-0.5 font-mono text-[9.5px] text-os-muted hover:border-os-accent/50 hover:text-os-accent">
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
            {structural ? (
              <KnowledgeGraph graph={structural.graph} focusNodeId={structural.focusNodeId ?? null} onSelectNode={(id) => void selectNode(id)} hideDirectory />
            ) : (
              RADIAL_SKELETON
            )}
            <p className="mt-1 font-mono text-[9px] text-os-dim">One canonical brain · company → missions → tasks → agents → artifacts/knowledge · click a node to inspect · projection, never persisted.</p>
          </div>
          <UniversalInspector view={view} loading={viewLoading} busy={busy} onAction={runAction} />
        </div>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center gap-1">
              <span className="mr-1 font-mono text-[9px] uppercase tracking-[0.2em] text-os-dim">window</span>
              {NEURAL_WINDOW_OPTIONS.map((w) => (
                <button key={w} onClick={() => setNeuralWindow(w)} aria-pressed={neuralWindow === w} className={`rounded-sm-t border px-2 py-0.5 font-mono text-[9.5px] ${neuralWindow === w ? 'border-os-accent text-os-accent' : 'border-os-border text-os-dim hover:text-os-muted'}`}>
                  {w}
                </button>
              ))}
              {root && <span className="ml-2 truncate font-mono text-[9px] text-os-dim">focus: {root}</span>}
              {operational?.generatedAt && <span className="ml-auto font-mono text-[9px] text-os-dim">as of {relTime(operational.generatedAt)}</span>}
            </div>
            {!operational ? (
              NEURAL_SKELETON
            ) : operational.graph.nodes.length === 0 ? (
              <div className="grid min-h-[280px] w-full place-items-center rounded-lg-t border border-dashed border-os-border bg-os-surface">
                <p className="px-6 text-center font-mono text-[11px] text-os-dim">No recent company activity in this window.<br />Try a wider window, or run a mission to see the operational flow.</p>
              </div>
            ) : (
              <NeuralGraph graph={operational.graph} onSelectNode={(id) => void selectNode(id)} hideDirectory layerNames={NEURAL_LAYER_NAMES} />
            )}
            <p className="mt-1 font-mono text-[9px] text-os-dim">Operational projection: missions → tasks → agents/workflow → runs → approvals → artifacts, over company_events + current canonical status · read-only · Activity (U4) is the chronological list.</p>
          </div>
          <UniversalInspector view={view} loading={viewLoading} busy={busy} onAction={runAction} />
        </div>
      )}
    </section>
  );
}
