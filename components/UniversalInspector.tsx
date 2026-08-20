'use client';

/**
 * Universal Inspector (Architecture V2 · F4) — one right-side surface for EVERY canonical
 * kind. Renders the typed `InspectorView` (sections + closed actions). It is a control
 * surface, NOT authority: `navigate` actions deep-link to the owning page; `api` actions
 * confirm then call an EXISTING endpoint. No arbitrary mutation, no LLM-generated URLs.
 */
import type { InspectorAction, InspectorView } from '@/lib/brain/inspector/model';
import { Badge } from '@/components/terminal';

type Props = {
  view: InspectorView | null;
  loading: boolean;
  busy: boolean;
  onAction: (action: InspectorAction) => void;
};

const KIND_TONE: Record<string, 'ok' | 'warn' | 'err' | 'default'> = {
  completed: 'ok', running: 'ok', active: 'ok', published: 'ok',
  failed: 'err', cancelled: 'default', archived: 'warn', waiting_approval: 'warn',
};

export function UniversalInspector({ view, loading, busy, onAction }: Props) {
  return (
    <aside className="w-full rounded-sm-t border border-os-border bg-os-surface p-3 lg:w-[320px] lg:shrink-0">
      <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-os-dim">Inspector</div>
      {loading ? (
        <p className="font-mono text-[10.5px] text-os-dim">Resolving…</p>
      ) : !view ? (
        <p className="font-mono text-[10.5px] text-os-dim">Select a node to inspect it.</p>
      ) : (
        <div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-[13px] font-semibold text-os-text">{view.entity.label}</span>
            <span className="shrink-0 font-mono text-[9px] uppercase text-os-dim">{view.entity.kind}</span>
            {view.entity.status && <Badge tone={KIND_TONE[view.entity.status] ?? 'default'}>{view.entity.status}</Badge>}
          </div>

          {view.sections.map((s) => (
            <section key={s.title} className="mt-3">
              <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-os-accent">{s.title}</div>
              <div className="flex flex-col gap-0.5">
                {s.rows.map((r, i) => (
                  <div key={`${s.title}-${i}`} className="flex items-baseline justify-between gap-2 font-mono text-[10px]">
                    <span className="shrink-0 text-os-dim">{r.label}</span>
                    <span className="min-w-0 truncate text-right text-os-muted">{r.value}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}

          {view.actions.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5 border-t border-os-border pt-3">
              {view.actions.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onAction(a)}
                  disabled={busy}
                  className={`rounded border px-2 py-1 font-mono text-[9.5px] uppercase disabled:opacity-40 ${
                    a.kind === 'api' ? 'border-os-accent/50 text-os-accent hover:bg-os-accent/10' : 'border-os-border-strong text-os-muted hover:text-os-text'
                  }`}
                  title={a.kind === 'api' ? 'Routes through the existing API (confirmation required)' : 'Open the owning surface'}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
