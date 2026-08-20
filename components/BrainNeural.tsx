'use client';

/**
 * G-Brain Neural (Architecture V2 · F5) — a bounded SVG projection of live/recent OPERATIONAL
 * state (missions → tasks → agents → workflow runs → approvals → artifacts) over a time window.
 * Deterministic left-to-right flow layout by kind, pan/zoom/fit (same mechanics as BrainRadial),
 * status colors, relative age, click → Universal Inspector. Only genuinely ACTIVE nodes pulse —
 * completed/failed history is static (no decorative animation). Read-only; never a runtime.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NeuralGraph, NeuralNode, NeuralStatus } from '@/lib/brain/neural/model';

type Props = {
  graph: NeuralGraph | null;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
};

const COL = 190;
const ROW = 66;
const KIND_RANK: Record<string, number> = { mission: 0, task: 1, event: 1, agent: 2, workflow: 2, workflow_run: 2, approval: 3, artifact: 3 };
const STATUS_CLASS: Record<NeuralStatus, string> = {
  running: 'text-os-ok', queued: 'text-os-muted', waiting: 'text-os-warn', waiting_approval: 'text-os-warn',
  completed: 'text-os-accent', failed: 'text-os-err', cancelled: 'text-os-dim', idle: 'text-os-dim',
};

function relAge(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/** Deterministic layered layout: x by kind-rank (flow direction), y by index within the column. */
function layout(graph: NeuralGraph): Map<string, { x: number; y: number }> {
  const byRank = new Map<number, NeuralNode[]>();
  for (const n of graph.nodes) {
    const r = KIND_RANK[n.kind] ?? 2;
    (byRank.get(r) ?? byRank.set(r, []).get(r)!).push(n);
  }
  const pos = new Map<string, { x: number; y: number }>();
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const midRank = (ranks[0] + ranks[ranks.length - 1]) / 2;
  for (const r of ranks) {
    const col = byRank.get(r)!;
    const midY = (col.length - 1) / 2;
    col.forEach((n, i) => pos.set(n.id, { x: (r - midRank) * COL, y: (i - midY) * ROW }));
  }
  return pos;
}

export function BrainNeural({ graph, loading, error, selectedId, onSelect }: Props) {
  const pos = useMemo(() => (graph && graph.nodes.length ? layout(graph) : new Map<string, { x: number; y: number }>()), [graph]);
  const [t, setT] = useState({ tx: 0, ty: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  useEffect(() => { setT({ tx: 0, ty: 0, k: 1 }); }, [graph?.root]);

  return (
    <div className="relative overflow-hidden rounded-sm-t border border-os-border bg-os-bg" style={{ height: 520 }}>
      <div className="absolute right-2 top-2 z-10 flex gap-1">
        <button onClick={() => setT((s) => ({ ...s, k: Math.min(s.k * 1.2, 4) }))} className="rounded border border-os-border bg-os-surface px-2 py-0.5 font-mono text-[11px] text-os-muted hover:text-os-text">+</button>
        <button onClick={() => setT((s) => ({ ...s, k: Math.max(s.k / 1.2, 0.3) }))} className="rounded border border-os-border bg-os-surface px-2 py-0.5 font-mono text-[11px] text-os-muted hover:text-os-text">−</button>
        <button onClick={() => setT({ tx: 0, ty: 0, k: 1 })} className="rounded border border-os-border bg-os-surface px-2 py-0.5 font-mono text-[9px] uppercase text-os-muted hover:text-os-text">Fit</button>
      </div>

      {graph && (
        <div className="absolute left-2 top-2 z-10 font-mono text-[9px] text-os-dim">
          as of {relAge(graph.generatedAt) || 'now'} · window {new Date(graph.window.from).toLocaleTimeString()}→now
        </div>
      )}

      {loading && !graph && <div className="absolute inset-0 z-10 flex items-center justify-center font-mono text-[10.5px] text-os-dim">Projecting operational state…</div>}
      {error && <div className="absolute inset-0 z-10 flex items-center justify-center font-mono text-[10.5px] text-os-err">⚠ {error} — retrying…</div>}
      {!loading && !error && graph && graph.nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center font-mono text-[10.5px] text-os-dim">No recent company activity in this window.</div>
      )}

      <svg
        viewBox="-450 -260 900 520"
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
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeWidth={0.8} opacity={0.5} />
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 3} fontSize={6} fill="currentColor" textAnchor="middle" opacity={0.7}>{e.type.replace(/_/g, ' ')}</text>
              </g>
            );
          })}
          {graph?.nodes.map((n: NeuralNode) => {
            const p = pos.get(n.id);
            if (!p) return null;
            const selected = n.id === selectedId;
            return (
              <g key={n.id} transform={`translate(${p.x} ${p.y})`} className={selected ? 'text-os-accent' : STATUS_CLASS[n.status ?? 'idle']} style={{ cursor: 'pointer' }} onClick={(ev) => { ev.stopPropagation(); onSelect(n.id); }}>
                {n.active && <circle r={13} fill="none" stroke="currentColor" strokeWidth={0.6} opacity={0.5} className="animate-pulse" />}
                <circle r={9} fill="var(--os-bg, #0a0a0a)" stroke="currentColor" strokeWidth={selected ? 2.4 : 1.2} />
                <text y={20} fontSize={8} fill="currentColor" textAnchor="middle">{n.label.length > 20 ? n.label.slice(0, 19) + '…' : n.label}</text>
                <text y={29} fontSize={5.5} fill="currentColor" textAnchor="middle" opacity={0.7}>{n.kind}{n.status ? ` · ${n.status}` : ''}{n.occurredAt ? ` · ${relAge(n.occurredAt)}` : ''}</text>
              </g>
            );
          })}
        </g>
      </svg>

      {graph?.truncated && <div className="absolute bottom-2 left-2 rounded border border-os-warn/40 bg-os-warn/5 px-2 py-0.5 font-mono text-[9px] text-os-warn">bounded view — more activity exists</div>}
    </div>
  );
}
