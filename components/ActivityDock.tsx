'use client';

/**
 * IGRIS Activity / Ops Stream dock (UX Foundation U4).
 *
 * A collapsible right-side panel answering "what is IGRIS doing right now, what
 * just happened, and what needs attention?" — a READ-ONLY view over
 * GET /api/activity (a projection of authoritative run/approval state). It never
 * mutates anything; clicking an item navigates to the canonical detail surface.
 *
 * Collapse is persisted in localStorage. To avoid the SSR hydration bug fixed
 * earlier, the FIRST client render matches the server (collapsed) and the real
 * preference is hydrated in a mount effect — never read in a useState initializer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, ChevronRight, RefreshCw, CheckCircle2, XCircle, PauseCircle, Play, CircleDot, AlertTriangle } from 'lucide-react';
import { ACTIVITY_OPEN_KEY, ACTIVITY_W, parseBoolPref, serializeBoolPref } from '@/lib/layout-prefs';
import {
  ACTIVITY_FILTERS,
  ACTIVITY_POLL_MS,
  canStartPoll,
  filterEvents,
  isNeedsAttention,
  navHrefForEvent,
  type ActivityEvent,
  type ActivityFilter,
} from '@/lib/activity/model';

const FILTER_LABEL: Record<ActivityFilter, string> = {
  all: 'All', flows: 'Flows', agents: 'Agents', approvals: 'Approvals', errors: 'Errors',
};

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function EventIcon({ e }: { e: ActivityEvent }) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  if (e.category === 'error') return <XCircle className={`${cls} text-os-err`} />;
  if (e.kind === 'run_waiting_approval' || (e.category === 'approval' && e.status === 'pending')) return <PauseCircle className={`${cls} text-os-warn`} />;
  if (e.kind === 'approval_approved' || e.status === 'success') return <CheckCircle2 className={`${cls} text-os-ok`} />;
  if (e.kind === 'approval_rejected') return <XCircle className={`${cls} text-os-warn`} />;
  if (e.status === 'running') return <Play className={`${cls} text-os-accent`} />;
  if (e.kind === 'run_started') return <CircleDot className={`${cls} text-os-muted`} />;
  return <CircleDot className={`${cls} text-os-dim`} />;
}

export function ActivityDock() {
  const router = useRouter();
  const [open, setOpen] = useState(false); // SSR = collapsed (matches server; no hydration mismatch)
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [stale, setStale] = useState(false); // last refresh failed but we still have prior data
  const [error, setError] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  // Hydrate the persisted open preference AFTER mount (never in the initializer).
  useEffect(() => {
    try {
      setOpen(parseBoolPref(localStorage.getItem(ACTIVITY_OPEN_KEY)));
    } catch {
      /* storage unavailable — stay collapsed */
    }
  }, []);

  // Reserve dock width only while open, so the main surface grows when collapsed.
  useEffect(() => {
    document.documentElement.style.setProperty('--activity-w', open ? `${ACTIVITY_W}px` : '0px');
  }, [open]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!canStartPoll({ open, mounted: mountedRef.current, inFlight: inFlightRef.current })) return;
    inFlightRef.current = true;
    try {
      const res = await fetch('/api/activity?limit=50', { cache: 'no-store' });
      if (!res.ok) throw new Error(`activity failed (${res.status})`);
      const body = (await res.json()) as { events?: ActivityEvent[] };
      if (!mountedRef.current) return;
      setEvents(Array.isArray(body.events) ? body.events : []);
      setError(null);
      setStale(false);
      setLoadedOnce(true);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setStale(true); // keep prior data but flag it — never show stale as fresh
    } finally {
      inFlightRef.current = false;
    }
  }, [open]);

  // Poll while open; immediate load on open; no overlap (guard above); clean up on unmount/close.
  useEffect(() => {
    if (!open) return;
    void load();
    const id = window.setInterval(() => void load(), ACTIVITY_POLL_MS);
    return () => window.clearInterval(id);
  }, [open, load]);

  const setOpenPersist = useCallback((next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(ACTIVITY_OPEN_KEY, serializeBoolPref(next));
    } catch {
      /* best-effort */
    }
  }, []);

  // Commander GO ("show activity" / "show errors") opens the dock (+ optional filter).
  useEffect(() => {
    const onEvent = (ev: Event) => {
      const detail = (ev as CustomEvent<{ filter?: ActivityFilter }>).detail;
      setOpenPersist(true);
      if (detail?.filter && (ACTIVITY_FILTERS as readonly string[]).includes(detail.filter)) setFilter(detail.filter);
    };
    window.addEventListener('igris:activity', onEvent);
    return () => window.removeEventListener('igris:activity', onEvent);
  }, [setOpenPersist]);

  const shown = filterEvents(events, filter);

  // Collapsed: a slim reopen tab on the right edge (overlay — reserves no width).
  if (!open) {
    return (
      <button
        onClick={() => setOpenPersist(true)}
        title="Open Activity"
        aria-label="Open Activity"
        className="fixed right-0 top-1/2 z-40 flex -translate-y-1/2 items-center gap-1.5 rounded-l-md border border-r-0 border-os-border bg-os-bg2 px-1.5 py-3 text-os-muted transition-colors hover:text-os-text"
        style={{ marginRight: 'var(--conductor-w, 0px)' }}
      >
        <Activity className="h-4 w-4" />
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] [writing-mode:vertical-rl]">Activity</span>
      </button>
    );
  }

  return (
    <aside
      className="fixed inset-y-0 z-40 flex flex-col border-l border-os-border bg-os-bg2"
      style={{ width: `${ACTIVITY_W}px`, right: 'var(--conductor-w, 0px)' }}
    >
      <div className="flex items-center gap-2 border-b border-os-border px-3.5 py-3">
        <Activity className="h-4 w-4 text-os-muted" />
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-os-text">Activity</span>
        <button onClick={() => void load()} title="Refresh" aria-label="Refresh activity" className="ml-auto text-os-dim transition-colors hover:text-os-text">
          <RefreshCw className={`h-3.5 w-3.5 ${inFlightRef.current ? 'animate-spin' : ''}`} />
        </button>
        <button onClick={() => setOpenPersist(false)} title="Collapse" aria-label="Collapse activity" className="text-os-dim transition-colors hover:text-os-text">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* filters */}
      <div className="flex flex-wrap gap-1 border-b border-os-border px-3 py-2">
        {ACTIVITY_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide transition-colors ${
              filter === f ? 'border-os-border-bright text-os-text' : 'border-os-border text-os-dim hover:text-os-text'
            }`}
          >
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>

      {stale && (
        <div className="flex items-center gap-1.5 border-b border-os-border bg-os-warn/5 px-3 py-1.5 font-mono text-[9.5px] text-os-warn">
          <AlertTriangle className="h-3 w-3" /> Couldn’t refresh — showing last known.
          <button onClick={() => void load()} className="ml-auto underline hover:text-os-text">Retry</button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loadedOnce && error ? (
          <div className="px-4 py-8 text-center">
            <p className="font-mono text-[11px] text-os-err">Activity unavailable</p>
            <button onClick={() => void load()} className="mt-2 rounded border border-os-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-os-muted hover:text-os-text">Retry</button>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-4 py-8 text-center font-mono text-[10.5px] text-os-dim">{loadedOnce ? 'No activity yet.' : 'Loading…'}</p>
        ) : (
          <ul className="py-1">
            {shown.map((e) => (
              <li key={e.id}>
                <button
                  onClick={() => router.push(navHrefForEvent(e))}
                  className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-os-surface2 ${
                    isNeedsAttention(e) ? 'border-l-2 border-l-os-warn' : 'border-l-2 border-l-transparent'
                  }`}
                >
                  <span className="mt-0.5"><EventIcon e={e} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] text-os-text">{e.title}</span>
                      <span className="shrink-0 font-mono text-[9px] text-os-dim">{hhmm(e.timestamp)}</span>
                    </span>
                    {e.detail && <span className="mt-0.5 block truncate font-mono text-[9.5px] text-os-dim">{e.detail}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
