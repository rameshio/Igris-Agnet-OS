'use client';

/**
 * G-Brain Radial (Architecture V2 · F4) — a deterministic SVG structural graph centered on
 * a root entity, with rings by graph distance, pan/zoom, fit-to-view, click-to-select, and
 * double-click-to-focus (re-root). No d3-force / no new deps. Persisted G-Brain edges are
 * solid; live PROJECTED canonical edges are dashed — so projection ≠ persistence is visible.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrainGraphNode, RadialGraph } from '@/lib/brain/projection/model';

type Props = {
  graph: RadialGraph | null;
  loading: boolean;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  onFocus: (nodeId: string) => void;
};

const RING = 150;
const KIND_CLASS: Record<string, string> = {
  agent: 'text-os-text', mission: 'text-os-accent', task: 'text-os-muted',
  artifact: 'text-os-ok', knowledge: 'text-os-warn', workflow: 'text-os-text',
  source: 'text-os-dim', capability: 'text-os-dim', department: 'text-os-dim',
  concept: 'text-os-muted', skill: 'text-os-dim', tool: 'text-os-dim', approval: 'text-os-warn',
};

/** BFS distance from root over the (undirected) edge set → deterministic ring placement. */
function layout(graph: RadialGraph): Map<string, { x: number; y: number }> {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
  }
  const dist = new Map<string, number>([[graph.root, 0]]);
  const queue = [graph.root];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur) ?? []) if (!dist.has(nb)) { dist.set(nb, (dist.get(cur) ?? 0) + 1); queue.push(nb); }
  }
  const byRing = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const d = dist.get(n.id) ?? 1;
    (byRing.get(d) ?? byRing.set(d, []).get(d)!).push(n.id);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [ring, ids] of byRing) {
    if (ring === 0) { pos.set(ids[0], { x: 0, y: 0 }); continue; }
    ids.forEach((id, i) => {
      const angle = (i / ids.length) * Math.PI * 2 - Math.PI / 2;
      pos.set(id, { x: Math.cos(angle) * RING * ring, y: Math.sin(angle) * RING * ring });
    });
  }
  return pos;
}

export function BrainRadial({ graph, loading, selectedId, onSelect, onFocus }: Props) {
  const pos = useMemo(() => (graph && graph.nodes.length ? layout(graph) : new Map<string, { x: number; y: number }>()), [graph]);
  const [t, setT] = useState({ tx: 0, ty: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // Reset the view whenever the root changes.
  useEffect(() => { setT({ tx: 0, ty: 0, k: 1 }); }, [graph?.root]);

  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);

  return (
    <div className="relative overflow-hidden rounded-sm-t border border-os-border bg-os-bg" style={{ height: 520 }}>
      <div className="absolute right-2 top-2 z-10 flex gap-1">
        <button onClick={() => setT((s) => ({ ...s, k: Math.min(s.k * 1.2, 4) }))} className="rounded border border-os-border bg-os-surface px-2 py-0.5 font-mono text-[11px] text-os-muted hover:text-os-text">+</button>
        <button onClick={() => setT((s) => ({ ...s, k: Math.max(s.k / 1.2, 0.3) }))} className="rounded border border-os-border bg-os-surface px-2 py-0.5 font-mono text-[11px] text-os-muted hover:text-os-text">−</button>
        <button onClick={() => setT({ tx: 0, ty: 0, k: 1 })} className="rounded border border-os-border bg-os-surface px-2 py-0.5 font-mono text-[9px] uppercase text-os-muted hover:text-os-text">Fit</button>
      </div>

      {loading && <div className="absolute inset-0 z-10 flex items-center justify-center font-mono text-[10.5px] text-os-dim">Projecting…</div>}
      {!loading && (!graph || graph.nodes.length === 0) && (
        <div className="absolute inset-0 flex items-center justify-center font-mono text-[10.5px] text-os-dim">Search or open an entity to see its structure.</div>
      )}

      <svg
        viewBox="-450 -300 900 600"
        className="h-full w-full cursor-grab active:cursor-grabbing"
        onWheel={(e) => setT((s) => ({ ...s, k: Math.max(0.3, Math.min(4, s.k * (e.deltaY < 0 ? 1.1 : 0.9))) }))}
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, tx: t.tx, ty: t.ty }; (e.target as Element).setPointerCapture?.(e.pointerId); }}
        onPointerMove={(e) => { if (drag.current) setT((s) => ({ ...s, tx: drag.current!.tx + (e.clientX - drag.current!.x), ty: drag.current!.ty + (e.clientY - drag.current!.y) })); }}
        onPointerUp={() => { drag.current = null; }}
      >
        <g transform={`translate(${t.tx} ${t.ty}) scale(${t.k})`}>
          {graph?.edges.map((e) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            return (
              <g key={e.id} className="text-os-dim">
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeWidth={0.8} strokeDasharray={e.persisted ? undefined : '4 3'} opacity={0.55} />
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} fontSize={6} fill="currentColor" textAnchor="middle" opacity={0.7}>{e.type}</text>
              </g>
            );
          })}
          {graph?.nodes.map((n: BrainGraphNode) => {
            const p = pos.get(n.id);
            if (!p) return null;
            const selected = n.id === selectedId;
            const isRoot = n.id === graph.root;
            return (
              <g
                key={n.id}
                transform={`translate(${p.x} ${p.y})`}
                className={selected ? 'text-os-accent' : KIND_CLASS[n.kind] ?? 'text-os-muted'}
                style={{ cursor: 'pointer' }}
                onClick={(ev) => { ev.stopPropagation(); onSelect(n.id); }}
                onDoubleClick={(ev) => { ev.stopPropagation(); if (n.expandable) onFocus(n.id); }}
              >
                <circle r={isRoot ? 13 : 9} fill="var(--os-bg, #0a0a0a)" stroke="currentColor" strokeWidth={selected ? 2.4 : isRoot ? 1.8 : 1.1} />
                {!n.persisted && <circle r={isRoot ? 13 : 9} fill="none" stroke="currentColor" strokeWidth={0.5} strokeDasharray="2 2" opacity={0.5} />}
                <text y={isRoot ? 26 : 20} fontSize={8} fill="currentColor" textAnchor="middle">{n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label}</text>
                <text y={isRoot ? 35 : 29} fontSize={5.5} fill="currentColor" textAnchor="middle" opacity={0.65}>{n.kind}</text>
              </g>
            );
          })}
        </g>
      </svg>

      {graph?.truncated && <div className="absolute bottom-2 left-2 rounded border border-os-warn/40 bg-os-warn/5 px-2 py-0.5 font-mono text-[9px] text-os-warn">bounded view — more neighbors exist</div>}
      {selectedId && nodeById.get(selectedId)?.expandable && (
        <div className="absolute bottom-2 right-2 font-mono text-[9px] text-os-dim">double-click a node to focus it</div>
      )}
    </div>
  );
}
