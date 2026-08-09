'use client';

/**
 * Notion-style agent dock: a slim expand tab on the right edge of every view
 * opens a vertical Conductor panel that knows what screen you're on. The
 * panel fetches /api/conductor/context for the current route, shows what it
 * sees, and sends that context with every message so the agent can talk
 * about "this screen" concretely. Chat itself is the existing conductor
 * pipeline (routes to the best-fit agent, @agent-id to force one).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, Send, X } from 'lucide-react';
import { SparkIcon } from '@/components/SparkIcon';
import { ConductorEmblem } from '@/components/ConductorEmblem';

type Turn = { id: string; role: 'user' | 'assistant'; content: string; routedTo?: string; ms?: number };
type ScreenCtx = { title: string; context: string };

/** A confirm-before-run operator action proposed by the Conductor. */
type ConductorAction =
  | { kind: 'create_agent'; name: string; instructions: string; departmentId: string }
  | { kind: 'update_agent'; agentId: string; agentName: string; name?: string; instructions?: string }
  | { kind: 'delete_agent'; agentId: string; agentName: string }
  | { kind: 'run_agent'; agentId: string; agentName: string }
  | { kind: 'run_flow' };

/** Cross-component open signal — the Topbar agent icon fires this. */
export const CONDUCTOR_OPEN_EVENT = 'conductor:open';

const WIDTH_KEY = 'alex-conductor-w';
const MIN_W = 300;
const MAX_W = 760;
const clampW = (w: number) => Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));

export function ConductorPanel() {
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  // Alex controls the size: drag the left edge; the width persists
  const [width, setWidth] = useState(380);
  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(stored) && stored > 0) setWidth(clampW(stored));
    } catch {
      /* storage unavailable — default width stands */
    }
  }, []);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  // live width during a drag — state updates batch, so persisting from state
  // on pointerup can save a stale value on fast flicks
  const widthRef = useRef(380);
  useEffect(() => {
    widthRef.current = width;
  }, [width]);
  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: e.clientX, startW: widthRef.current };
    // 1:1 tracking while dragging — the glide transition would lag the handle
    document.documentElement.classList.add('conductor-dragging');
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic/stale pointer — drag still tracks via move events */
    }
  };
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const w = clampW(d.startW + (d.startX - e.clientX));
    widthRef.current = w;
    setWidth(w);
  };
  const onHandleUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.documentElement.classList.remove('conductor-dragging');
    try {
      localStorage.setItem(WIDTH_KEY, String(widthRef.current));
    } catch {
      /* fine */
    }
  };

  // the Topbar agent icon opens the dock from anywhere
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(CONDUCTOR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CONDUCTOR_OPEN_EVENT, onOpen);
  }, []);

  // the dock PUSHES the content instead of covering it: publish the width as
  // a CSS var the layout shell reads for its right margin
  useEffect(() => {
    document.documentElement.style.setProperty('--conductor-w', open ? `${width}px` : '0px');
    return () => {
      document.documentElement.style.setProperty('--conductor-w', '0px');
    };
  }, [open, width]);
  const [ctx, setCtx] = useState<ScreenCtx | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // an operator action awaiting the operator's confirmation (confirm-each mode)
  const [pending, setPending] = useState<ConductorAction | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0); // live seconds while the brain is thinking
  const scrollRef = useRef<HTMLDivElement>(null);

  // tick a live timer whenever a request is in flight
  useEffect(() => {
    if (!sending) return;
    const start = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed((Date.now() - start) / 1000), 100);
    return () => clearInterval(id);
  }, [sending]);

  const addAssistant = (content: string) =>
    setTurns((t) => [...t, { id: `a-${t.length}-${Date.now()}`, role: 'assistant', content, routedTo: 'conductor' }]);

  const loadContext = useCallback(async (path: string) => {
    setCtx(null);
    try {
      const res = await fetch(`/api/conductor/context?path=${encodeURIComponent(path)}`);
      if (res.ok) setCtx((await res.json()) as ScreenCtx);
    } catch {
      // panel still works without context — the chat just loses screen grounding
    }
  }, []);

  useEffect(() => {
    if (open) void loadContext(pathname);
  }, [open, pathname, loadContext]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    setTurns((t) => [...t, { id: `u-${t.length}`, role: 'user', content: text }]);
    setInput('');
    const startedAt = Date.now();
    try {
      const res = await fetch('/api/agents/conductor/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          context: ctx ? `Screen: ${ctx.title}\n${ctx.context}` : undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `conductor failed (${res.status})`);
      }
      const body = (await res.json()) as { routedTo: string; reply: string; action?: ConductorAction };
      const ms = (Date.now() - startedAt) / 1000;
      setTurns((t) => [...t, { id: `a-${t.length}`, role: 'assistant', content: body.reply, routedTo: body.routedTo, ms }]);
      if (body.action) setPending(body.action); // needs the operator's OK before it runs
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  /** Execute a confirmed action against the existing write endpoints. */
  async function runAction(a: ConductorAction) {
    setRunning(true);
    setError(null);
    try {
      if (a.kind === 'create_agent') {
        const res = await fetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: a.name, departmentId: a.departmentId, instructions: a.instructions, tools: [], model: '', enabled: true }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.agent) throw new Error(j?.error ?? 'create failed');
        addAssistant(`✓ Created agent "${j.agent.name}". It's on /agents and the G-Brain canvas now.`);
      } else if (a.kind === 'update_agent') {
        const res = await fetch(`/api/agents/${a.agentId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(a.name ? { name: a.name } : {}), ...(a.instructions ? { instructions: a.instructions } : {}) }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.agent) throw new Error(j?.error ?? 'update failed');
        addAssistant(`✓ Updated "${j.agent.name}".`);
      } else if (a.kind === 'delete_agent') {
        const res = await fetch(`/api/agents/${a.agentId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('delete failed');
        addAssistant(`✓ Deleted "${a.agentName}".`);
      } else if (a.kind === 'run_agent') {
        addAssistant(`Running ${a.agentName}… ~40s on Hermes.`);
        const res = await fetch(`/api/agents/${a.agentId}/run`, { method: 'POST' });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.run) throw new Error(j?.error ?? 'run failed');
        addAssistant(`✓ ${a.agentName} ran. ${(j.run.output ?? j.run.summary ?? '').toString().slice(0, 200)}`.trim());
      } else if (a.kind === 'run_flow') {
        const flowRes = await fetch('/api/agent-flows');
        const flow = flowRes.ok ? await flowRes.json().catch(() => null) : null;
        if (!flow?.nodes?.length) throw new Error('no saved flow to run');
        addAssistant('Running the agent flow… each step is ~40s on Hermes.');
        const res = await fetch('/api/agent-flows/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nodes: flow.nodes.map((n: { id: string; agentId: string }) => ({ id: n.id, agentId: n.agentId })),
            edges: (flow.edges ?? []).map((e: { source: string; target: string }) => ({ source: e.source, target: e.target })),
          }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !Array.isArray(j?.steps)) throw new Error(j?.error ?? 'flow run failed');
        addAssistant(`✓ Flow complete — ${j.steps.length} step(s). ${j.detail ?? ''}`.trim());
      }
    } catch (err) {
      addAssistant(`⚠ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
      setPending(null);
    }
  }

  const persistWidth = (w: number) => {
    const next = clampW(w);
    widthRef.current = next;
    setWidth(next);
    try {
      localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      /* fine */
    }
  };

  return (
    <>
      {/* corner agent — tucked away bottom-right, pops its label out on
          hover, never in the way; click opens the dock */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open the Conductor agent panel"
          title="Ask the Conductor about this screen"
          className="group fixed bottom-5 right-5 z-40 flex items-center rounded-full border border-os-border-strong bg-os-surface/90 p-2.5 opacity-60 backdrop-blur transition-all duration-300 hover:opacity-100 hover:pr-3.5"
          style={{ transitionTimingFunction: 'var(--ease)', boxShadow: 'none' }}
        >
          <SparkIcon size={17} shade="var(--text)" />
          <span
            className="max-w-0 overflow-hidden whitespace-nowrap font-mono text-[10.5px] tracking-wide text-os-muted transition-all duration-300 group-hover:ml-2 group-hover:max-w-[130px]"
            style={{ transitionTimingFunction: 'var(--ease)' }}
          >
            Ask Conductor
          </span>
        </button>
      )}

      {/* the dock — opened from the Topbar agent icon or the corner bubble,
          resizable from its left edge, width remembered across sessions */}
      <aside
        aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-50 flex max-w-[92vw] flex-col border-l border-os-border-strong bg-os-surface transition-transform duration-[420ms] ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ transitionTimingFunction: 'var(--ease)', width }}
      >
        {/* resize handle */}
        <div
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          title="Drag to resize"
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-os-accent/30"
          style={{ touchAction: 'none' }}
        />

        {/* edge arrows: ‹ widens the panel a step, › slides it away — hidden
            while closed so they don't poke past the off-screen edge */}
        <div
          className={`absolute -left-3 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-1.5 transition-opacity duration-300 ${
            open ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          <button
            onClick={() => persistWidth(widthRef.current + 140)}
            disabled={width >= MAX_W}
            aria-label="Widen the panel"
            title="Wider"
            className="grid h-7 w-7 place-items-center rounded-full border border-os-border-strong bg-os-surface text-os-dim shadow-sm transition-colors hover:text-os-accent disabled:opacity-30"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setOpen(false)}
            aria-label="Slide the panel away"
            title="Slide away"
            className="grid h-7 w-7 place-items-center rounded-full border border-os-border-strong bg-os-surface text-os-dim shadow-sm transition-colors hover:text-os-text"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <header className="flex items-center gap-2.5 border-b border-os-border px-4 py-3">
          <ConductorEmblem size={32} thinking={sending} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-bold tracking-[0.12em]">CONDUCTOR</div>
            <div className="truncate font-mono text-[9.5px] uppercase tracking-wide text-os-dim">
              seeing: {ctx?.title ?? '…'}
            </div>
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close Conductor"
            className="shrink-0 rounded-sm-t p-1 text-os-dim transition-colors hover:text-os-text"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {ctx && (
          <p
            className="border-b border-os-border px-4 py-2 font-mono text-[10px] leading-relaxed text-os-dim"
            title={ctx.context}
          >
            {ctx.context.split('\n')[0]}
          </p>
        )}

        <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {turns.length === 0 && (
            <p className="pt-6 text-center font-mono text-[10.5px] leading-relaxed text-os-dim">
              Ask about this screen — the Conductor sees what you see
              <br />
              and routes to the best-fit agent (@agent-id to force one).
            </p>
          )}
          {turns.map((t) =>
            t.role === 'user' ? (
              <div key={t.id} className="text-right">
                <span className="inline-block max-w-[88%] break-words rounded-md bg-os-surface2 px-2.5 py-1.5 text-left text-[11.5px] text-os-text">
                  {t.content}
                </span>
              </div>
            ) : (
              <div key={t.id} className="text-left">
                {(t.routedTo || t.ms != null) && (
                  <div className="mb-0.5 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-os-accent">
                    {t.routedTo && <span>→ {t.routedTo}</span>}
                    {t.ms != null && <span className="text-os-dim">· {t.ms.toFixed(1)}s</span>}
                  </div>
                )}
                <span className="inline-block max-w-[92%] whitespace-pre-wrap break-words rounded-md border border-os-border bg-os-bg px-2.5 py-1.5 text-[11.5px] leading-relaxed text-os-muted">
                  {t.content}
                </span>
              </div>
            ),
          )}
          {sending && (
            <div className="flex items-center gap-2">
              <ConductorEmblem size={18} thinking />
              <span className="font-mono text-[10px] text-os-dim">thinking… {elapsed.toFixed(1)}s</span>
            </div>
          )}
          {error && <p className="font-mono text-[10px] text-os-err">⚠ {error}</p>}
        </div>

        {/* confirm-before-run card for a proposed operator action */}
        {pending && (
          <div className="mx-3 mb-2 rounded-md border border-os-border-strong bg-os-bg p-3">
            <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-os-accent">
              {pending.kind === 'delete_agent' ? 'Confirm — destructive' : 'Confirm action'}
            </div>
            <div className="mt-1 text-[12px] font-bold text-os-text">
              {pending.kind === 'create_agent' && `Create agent “${pending.name}”`}
              {pending.kind === 'update_agent' && `Update “${pending.agentName}”`}
              {pending.kind === 'delete_agent' && `Delete “${pending.agentName}”`}
              {pending.kind === 'run_agent' && `Run “${pending.agentName}”`}
              {pending.kind === 'run_flow' && 'Run the agent flow'}
            </div>
            {pending.kind === 'create_agent' && (
              <p className="mt-1 line-clamp-3 font-mono text-[10px] leading-relaxed text-os-muted">{pending.instructions}</p>
            )}
            {pending.kind === 'update_agent' && (
              <p className="mt-1 font-mono text-[10px] leading-relaxed text-os-muted">
                {pending.name ? `New name: ${pending.name}. ` : ''}
                {pending.instructions ? `New instructions: ${pending.instructions.slice(0, 140)}…` : ''}
              </p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => runAction(pending)}
                disabled={running}
                className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] font-semibold transition-opacity disabled:opacity-50 ${
                  pending.kind === 'delete_agent'
                    ? 'border-os-err bg-os-err text-os-bg'
                    : 'border-os-border-bright bg-os-text text-os-bg'
                }`}
              >
                {running ? 'Working…' : pending.kind === 'delete_agent' ? 'Confirm delete' : 'Confirm'}
              </button>
              <button
                onClick={() => {
                  setPending(null);
                  addAssistant('Cancelled.');
                }}
                disabled={running}
                className="rounded-md border border-os-border px-3 py-1.5 text-[11px] font-semibold text-os-muted transition-colors hover:text-os-text disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-1.5 border-t border-os-border p-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder={`Ask about ${ctx?.title ?? 'this screen'}…`}
            disabled={sending}
            className="min-w-0 flex-1 rounded-full border border-os-border bg-os-bg px-3 py-1.5 text-xs text-os-text placeholder:text-os-dim focus:border-os-border-strong focus:outline-none"
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            aria-label="Send"
            className="flex shrink-0 items-center rounded-full border border-os-border-strong bg-os-surface2 px-3 py-1.5 text-os-text transition-opacity hover:border-os-dim disabled:opacity-40"
          >
            <Send className="h-3 w-3" />
          </button>
        </div>
      </aside>
    </>
  );
}
