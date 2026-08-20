'use client';

/**
 * G-Brain Core panel (Architecture V2 · F3) — the minimal UI over the canonical company
 * knowledge layer (`/api/brain/*`). It renders BELOW the existing /brain visualization and
 * changes none of it. Knowledge + search + explicit create + entity list + neighborhood.
 * The board only REQUESTS operations; the G-Brain services enforce validation + provenance.
 * React never touches SQLite. Durable knowledge is created only by explicit operator action.
 */
import { useCallback, useEffect, useState } from 'react';
import type { SafeBrainKnowledge, BrainEntity, KnowledgeKind } from '@/lib/brain/core/model';
import type { BrainSearchHit } from '@/lib/brain/core/search';
import { KNOWLEDGE_KINDS } from '@/lib/brain/core/model';
import { SectionHead } from '@/components/terminal';

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data: T | null; error?: string }> {
  try {
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    return { ok: res.ok, data: res.ok ? data : null, error: res.ok ? undefined : data?.error ?? `error ${res.status}` };
  } catch (e) {
    return { ok: false, data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export function BrainCorePanel() {
  const [knowledge, setKnowledge] = useState<SafeBrainKnowledge[]>([]);
  const [entities, setEntities] = useState<BrainEntity[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<BrainSearchHit[] | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<KnowledgeKind>('note');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [k, e] = await Promise.all([
      api<{ knowledge: SafeBrainKnowledge[] }>('/api/brain/knowledge'),
      api<{ entities: BrainEntity[] }>('/api/brain/entities'),
    ]);
    setKnowledge(k.data?.knowledge ?? []);
    setEntities(e.data?.entities ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const search = async () => {
    if (!query.trim()) return setHits(null);
    const r = await api<{ results: BrainSearchHit[] }>(`/api/brain/search?q=${encodeURIComponent(query.trim())}`);
    setHits(r.data?.results ?? []);
  };

  const createKnowledge = async () => {
    if (!title.trim() || !content.trim()) return;
    const r = await api('/api/brain/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), content: content.trim(), kind }),
    });
    setError(r.ok ? null : r.error ?? 'error');
    if (r.ok) {
      setTitle('');
      setContent('');
      await load();
    }
  };

  return (
    <section className="mt-8 rounded-lg-t border border-os-border bg-os-surface p-5">
      <SectionHead label="Company Knowledge · G-Brain Core" />
      <p className="mb-4 mt-1 font-mono text-[10px] text-os-dim">
        Durable company knowledge + relationships + provenance (F3). Explicit only — nothing here is auto-captured.
        Separate from the external brain-store viz above.
      </p>

      {error && <div className="mb-3 rounded border border-os-err/50 bg-os-err/5 px-3 py-2 font-mono text-[10.5px] text-os-err">⚠ {error}</div>}

      {/* Search */}
      <div className="mb-4 flex gap-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="Search knowledge, entities, sources…"
          className="min-w-0 flex-1 rounded border border-os-border bg-os-bg px-2 py-1.5 font-mono text-[11px] text-os-text placeholder:text-os-dim"
        />
        <button onClick={search} className="shrink-0 rounded border border-os-border-strong px-3 py-1.5 font-mono text-[10px] uppercase text-os-muted hover:text-os-text">Search</button>
        {hits !== null && <button onClick={() => { setHits(null); setQuery(''); }} className="shrink-0 rounded border border-os-border px-2 py-1.5 font-mono text-[10px] uppercase text-os-dim hover:text-os-text">Clear</button>}
      </div>

      {hits !== null && (
        <div className="mb-5">
          <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-os-dim">Results · {hits.length}</div>
          {hits.length === 0 ? (
            <p className="font-mono text-[10.5px] text-os-dim">No matches.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {hits.map((h) => (
                <li key={`${h.kind}:${h.id}`} className="flex items-baseline gap-2 rounded-sm-t border border-os-border bg-os-bg px-2.5 py-1 font-mono text-[9.5px]">
                  <span className="shrink-0 uppercase tracking-wide text-os-accent">{h.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-os-muted">{h.title}{h.kind === 'knowledge' ? ` — ${h.snippet}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        {/* Knowledge list + create */}
        <div className="min-w-0">
          <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-os-dim">Knowledge · {knowledge.length}</div>
          <div className="mb-3 flex flex-col gap-1.5">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Knowledge title…" className="rounded border border-os-border bg-os-bg px-2 py-1.5 font-mono text-[11px] text-os-text placeholder:text-os-dim" />
            <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Content…" rows={2} className="rounded border border-os-border bg-os-bg px-2 py-1.5 font-mono text-[10.5px] text-os-text placeholder:text-os-dim" />
            <div className="flex gap-1.5">
              <select value={kind} onChange={(e) => setKind(e.target.value as KnowledgeKind)} className="rounded border border-os-border bg-os-bg px-1.5 py-1 font-mono text-[9.5px] uppercase text-os-muted">
                {KNOWLEDGE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <button onClick={createKnowledge} className="rounded border border-os-accent/50 px-2.5 py-1 font-mono text-[10px] uppercase text-os-accent hover:bg-os-accent/10">Save knowledge</button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            {knowledge.length === 0 && <p className="rounded border border-os-border bg-os-bg px-3 py-4 text-center font-mono text-[10.5px] text-os-dim">No knowledge yet.</p>}
            {knowledge.slice(0, 20).map((k) => (
              <div key={k.id} className="rounded-sm-t border border-os-border bg-os-bg px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12px] font-semibold text-os-text">{k.title}</span>
                  <span className="shrink-0 font-mono text-[9px] uppercase text-os-dim">{k.kind}</span>
                  {k.status === 'archived' && <span className="shrink-0 font-mono text-[9px] uppercase text-os-warn">archived</span>}
                </div>
                {k.summary && <div className="mt-0.5 line-clamp-2 font-mono text-[9.5px] text-os-muted">{k.summary}</div>}
                {k.sourceId && <div className="mt-0.5 font-mono text-[9px] text-os-dim">source: {k.sourceId}{k.createdByAgentId ? ` · by ${k.createdByAgentId}` : ''}</div>}
              </div>
            ))}
          </div>
        </div>

        {/* Entities */}
        <div className="min-w-0">
          <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-os-dim">Entities · {entities.length}</div>
          <div className="flex flex-col gap-1.5">
            {entities.length === 0 && <p className="rounded border border-os-border bg-os-bg px-3 py-4 text-center font-mono text-[10.5px] text-os-dim">No entities yet.</p>}
            {entities.slice(0, 24).map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-2 rounded-sm-t border border-os-border bg-os-bg px-2.5 py-1.5">
                <span className="min-w-0 truncate font-mono text-[10px] text-os-muted">{e.name}</span>
                <span className="shrink-0 font-mono text-[9px] uppercase text-os-dim">{e.type}{e.canonicalRef ? ` · ${e.canonicalRef.kind}` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
