'use client';

/**
 * IGRIS Commander — the ONE global command surface (Ctrl/Cmd+K). Three lanes:
 *   GO  — deterministic navigation/search (immediate; non-destructive).  [U2]
 *   ASK — reasoning via the Conductor, grounded with U1 context IDs only. [U2]
 *   DO  — Plan → Preview → Execute. A DO request is recognized as a TYPED action
 *         (lib/commander-actions), a PREVIEW is built from authoritative backend
 *         data, and nothing runs until the human explicitly confirms
 *         (Ctrl/Cmd+Enter). Execution goes through existing mutation APIs only —
 *         the Commander never invents a URL, method, or body.               [U3]
 *
 * Safety: plain Enter NEVER executes a DO action (it only builds the preview);
 * only an explicit confirm does. GO/ASK can never execute a mutation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, CornerDownLeft, ShieldAlert, Check, X, Loader2, ExternalLink } from 'lucide-react';
import { type Command } from '@/lib/palette';
import { DIGIT_VIEWS, NAV_OPERATE, NAV_AGENTS, NAV_INTELLIGENCE, NAV_SYSTEM, NAV_LIBRARY } from '@/lib/nav';
import { useIgrisContext } from '@/lib/context-envelope';
import {
  classifyInput,
  goHits,
  describeContext,
  buildAskContext,
  unresolvedReferences,
  isCommanderToggle,
  navToCommands,
  mergeCommands,
  type CommanderLane,
} from '@/lib/commander';
import {
  recognizeCommanderAction,
  previewPlan,
  executePlan,
  buildRunPreview,
  buildPublishPreview,
  buildDeletePreview,
  buildApprovalPreview,
  buildHermesPreview,
  formatResult,
  type CommanderAction,
  type CommanderPreview,
  type CommanderResult,
  type RiskLevel,
} from '@/lib/commander-actions';

function isTyping(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

const LANE_STYLE: Record<CommanderLane, string> = {
  go: 'border-os-border-bright text-os-text',
  ask: 'border-os-accent/60 text-os-accent',
  do: 'border-os-warn/60 text-os-warn',
};

const RISK_STYLE: Record<RiskLevel, string> = {
  low: 'border-os-border-bright text-os-muted',
  medium: 'border-os-warn/60 text-os-warn',
  high: 'border-os-err/60 text-os-err',
};

/**
 * DO lane state machine (explicit, no tangled booleans):
 *   idle → loading → preview → executing → result | error
 * `recognized` / `missing` / `unknown` describe the *input*, before any preview.
 */
type DoState =
  | { phase: 'loading'; action: CommanderAction }
  | { phase: 'preview'; action: CommanderAction; preview: CommanderPreview }
  | { phase: 'executing'; action: CommanderAction; preview: CommanderPreview }
  | { phase: 'result'; result: CommanderResult }
  | { phase: 'error'; message: string };

/** Map an authoritative preview response to the right pure preview builder. */
function buildPreviewFor(action: CommanderAction, body: Record<string, unknown>): CommanderPreview {
  switch (action.type) {
    case 'run_workflow':
      return buildRunPreview(action, body as never);
    case 'publish_workflow':
      return buildPublishPreview(action, body as never);
    case 'delete_workflow':
      return buildDeletePreview(action, body as never);
    case 'resolve_approval': {
      const a = (body.approval ?? {}) as Record<string, unknown>;
      return buildApprovalPreview(action, {
        id: String(a.id ?? action.approvalId),
        status: String(a.status ?? 'unknown'),
        requestType: a.requestType as string | undefined,
        title: a.title as string | undefined,
        message: a.message as string | undefined,
        workflowId: a.workflowId as string | undefined,
        workflowVersion: a.workflowVersion as number | undefined,
        runId: a.runId as string | undefined,
        approvalRoute: a.approvalRoute as string | undefined,
        rejectionRoute: a.rejectionRoute as string | undefined,
      });
    }
    case 'set_hermes_transport':
      return buildHermesPreview(action, body as never);
  }
}

export function Commander({ commands }: { commands: Command[] }) {
  const router = useRouter();
  const env = useIgrisContext();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [forced, setForced] = useState<CommanderLane | undefined>(undefined);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // ASK state (shares the Conductor backend)
  const [answer, setAnswer] = useState<{ q: string; reply: string; routedTo?: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  // DO state (Plan → Preview → Execute)
  const [doState, setDoState] = useState<DoState | null>(null);

  const allCommands = useMemo(
    () => mergeCommands(navToCommands([...NAV_OPERATE, ...NAV_AGENTS, ...NAV_INTELLIGENCE, ...NAV_SYSTEM, ...NAV_LIBRARY]), commands),
    [commands],
  );
  const intent = useMemo(() => classifyInput(query, forced), [query, forced]);
  const hits = useMemo(() => goHits(allCommands, intent, 8), [allCommands, intent]);
  // Recognize the DO utterance against the live envelope (pure; no execution).
  const recognized = useMemo(
    () => (intent.lane === 'do' && intent.query.trim() ? recognizeCommanderAction(intent.query, env) : null),
    [intent, env],
  );

  // Single writer for DO state that ALSO updates a synchronous ref mirror. The
  // ref is the double-submit guard: `execute` reads and flips it synchronously,
  // so a second confirm (or a React StrictMode double-invoke) sees `executing`
  // and short-circuits BEFORE a second mutation can fire. The side effect must
  // live outside any setState updater for this to hold (updaters are re-invoked
  // by StrictMode) — so `execute` does its fetch in the callback body, not here.
  const doStateRef = useRef<DoState | null>(null);
  const applyDo = useCallback((next: DoState | null) => {
    doStateRef.current = next;
    setDoState(next);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setForced(undefined);
    setIndex(0);
    setAnswer(null);
    setAskError(null);
    applyDo(null);
  }, [applyDo]);

  const resetTransient = useCallback(() => {
    setAnswer(null);
    setAskError(null);
    applyDo(null);
  }, [applyDo]);

  // Build the preview for a recognized, fully-grounded action. GET only — no
  // mutation, so plain Enter can safely trigger this.
  const loadPreview = useCallback(async (action: CommanderAction) => {
    applyDo({ phase: 'loading', action });
    try {
      const plan = previewPlan(action);
      const res = await fetch(plan.path, { method: plan.method });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        applyDo({ phase: 'error', message: (body?.error as string) || `Could not load preview (${res.status}).` });
        return;
      }
      applyDo({ phase: 'preview', action, preview: buildPreviewFor(action, body ?? {}) });
    } catch (err) {
      applyDo({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [applyDo]);

  // Execute an already-previewed action. Requires an EXPLICIT confirm. The
  // synchronous ref flip below is the authoritative double-submit guard: exactly
  // one confirm ⇒ exactly one mutation (the backend remains the idempotency
  // authority regardless).
  const execute = useCallback(async () => {
    const s = doStateRef.current;
    if (!s || s.phase !== 'preview' || s.preview.blocked) return; // only from a confirmable preview
    const { action, preview } = s;
    applyDo({ phase: 'executing', action, preview }); // flips the ref synchronously → re-entry blocked
    try {
      const plan = executePlan(action);
      const res = await fetch(plan.path, {
        method: plan.method,
        headers: plan.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: plan.body !== undefined ? JSON.stringify(plan.body) : undefined,
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      applyDo({ phase: 'result', result: formatResult(action, res.ok, body) });
    } catch (err) {
      applyDo({ phase: 'result', result: formatResult(action, false, { error: err instanceof Error ? err.message : String(err) }) });
    }
  }, [applyDo]);

  // ⌘K toggle · Esc (context-aware) · digit 1–9 jump (when closed) · open event.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isCommanderToggle(e)) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        // Esc never aborts an in-flight mutation; it steps back one stage.
        const s = doStateRef.current;
        if (s && (s.phase === 'preview' || s.phase === 'error' || s.phase === 'result')) {
          applyDo(null); // cancel preview / clear result, stay open
        } else if (s && (s.phase === 'loading' || s.phase === 'executing')) {
          /* in flight — do not interrupt */
        } else {
          close();
        }
      } else if (!open && /^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping()) {
        const href = DIGIT_VIEWS[Number(e.key) - 1];
        if (href) router.push(href);
      }
    }
    // Home (U6) opens the Commander via this event, optionally prefilling the
    // typed command — one command system, no duplicate input. An empty dispatch
    // (⌘K, other callers) behaves exactly as before.
    const onOpenEvent = (e: Event) => {
      setOpen(true);
      const detail = (e as CustomEvent).detail as { prefill?: string } | undefined;
      if (detail?.prefill && typeof detail.prefill === 'string') {
        setQuery(detail.prefill);
        setForced(undefined);
        setIndex(0);
        resetTransient();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('alex:palette', onOpenEvent);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('alex:palette', onOpenEvent);
    };
  }, [close, open, router, applyDo, resetTransient]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const navigate = useCallback(
    (href: string | undefined) => {
      if (!href) return;
      close();
      if (href.startsWith('http')) window.open(href, '_blank');
      else router.push(href);
    },
    [close, router],
  );

  const ask = useCallback(async () => {
    const q = intent.query.trim();
    if (!q || asking) return;
    const missing = unresolvedReferences(env, q);
    if (missing.length > 0) {
      setAnswer({ q, reply: `Nothing is selected for ${missing.join(', ')}. Open the relevant surface and select it, then ask again.` });
      return;
    }
    setAsking(true);
    setAskError(null);
    setAnswer(null);
    try {
      const res = await fetch('/api/agents/conductor/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: q, context: buildAskContext(env) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `conductor failed (${res.status})`);
      }
      const body = (await res.json()) as { routedTo?: string; reply: string; action?: unknown };
      // ASK NEVER executes a proposed action — surface it, do not run it. A real
      // side effect must go through the DO lane's preview + confirm.
      const note = body.action ? '\n\n(The Conductor also proposed an action — switch to DO and confirm the preview to run it.)' : '';
      setAnswer({ q, reply: `${body.reply}${note}`, routedTo: body.routedTo });
    } catch (err) {
      setAskError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }, [asking, env, intent.query]);

  // Plain Enter: GO navigates, ASK asks, DO builds the PREVIEW (never executes).
  const onSubmit = useCallback(() => {
    if (intent.lane === 'go') {
      // Trivial U4 hook: "show activity" / "show errors" open the Activity dock
      // (no navigation, no new routing) — the dock listens for this event.
      const q = intent.query.trim().toLowerCase();
      if (/^(show\s+)?(activity|ops)$/.test(q) || /^(show\s+)?errors$/.test(q)) {
        window.dispatchEvent(new CustomEvent('igris:activity', { detail: { filter: /error/.test(q) ? 'errors' : 'all' } }));
        close();
        return;
      }
      navigate(intent.slashHref ?? hits[index]?.href);
    } else if (intent.lane === 'ask') {
      void ask();
    } else if (intent.lane === 'do') {
      if (recognized?.kind === 'action' && (!doState || doState.phase === 'error')) void loadPreview(recognized.action);
      // If a preview is already showing, plain Enter does nothing — confirm needs ⌘/Ctrl+Enter.
    }
  }, [intent, hits, index, navigate, ask, recognized, doState, loadPreview, close]);

  if (!open) return null;

  const contextLabel = describeContext(env);
  const canConfirm = doState?.phase === 'preview' && !doState.preview.blocked;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-os-bg/60 pt-[14vh] backdrop-blur-sm" onClick={close}>
      <div
        className="w-[600px] max-w-[calc(100vw-48px)] overflow-hidden rounded-lg-t border border-os-border-strong bg-os-surface shadow-[0_24px_80px_-16px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header: title + live context indicator */}
        <div className="flex items-center gap-2 border-b border-os-border px-4 py-2">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-os-dim">IGRIS Commander</span>
          <span className="ml-auto truncate font-mono text-[9.5px] text-os-dim" title={`Context: ${contextLabel}`}>
            Context: <span className="text-os-muted">{contextLabel}</span>
          </span>
        </div>

        {/* input row: lane chip + query */}
        <div className="flex items-center gap-2 border-b border-os-border px-4">
          <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.16em] ${LANE_STYLE[intent.lane]}`}>
            {intent.lane}
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setForced(undefined);
              setIndex(0);
              resetTransient();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                // Explicit confirm — the ONLY keystroke that executes a DO action.
                e.preventDefault();
                if (canConfirm) void execute();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, Math.max(hits.length - 1, 0)));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                onSubmit();
              }
            }}
            placeholder="What do you want IGRIS to do?  (/flows · open approvals · run this workflow)"
            className="w-full bg-transparent py-4 font-mono text-sm text-os-text outline-none placeholder:text-os-dim"
          />
        </div>

        {/* lane correction (simple) */}
        {query.trim() && (
          <div className="flex items-center gap-2 border-b border-os-border px-4 py-1.5">
            <span className="font-mono text-[9px] uppercase tracking-wide text-os-dim">mode</span>
            {(['go', 'ask', 'do'] as CommanderLane[]).map((l) => (
              <button
                key={l}
                onClick={() => { setForced(l); resetTransient(); }}
                className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide transition-colors ${
                  intent.lane === l ? LANE_STYLE[l] : 'border-os-border text-os-dim hover:text-os-text'
                }`}
              >
                {l}
              </button>
            ))}
            <span className="ml-auto font-mono text-[9px] text-os-dim">
              {intent.lane === 'do' ? 'Enter = preview · ⌘/Ctrl+Enter = confirm' : 'Enter ↵'}
            </span>
          </div>
        )}

        {/* body per lane */}
        <div className="max-h-[46vh] overflow-y-auto p-1.5">
          {intent.lane === 'go' && (
            <>
              {intent.slashHref ? (
                <button onClick={() => navigate(intent.slashHref)} className="flex w-full items-center gap-2.5 rounded-sm-t bg-[var(--accent-soft)] px-3 py-[9px] text-left text-[13px] text-os-text">
                  <CornerDownLeft className="h-3.5 w-3.5 opacity-60" /> Go to {intent.slashHref}
                </button>
              ) : hits.length === 0 ? (
                <p className="px-4 py-6 text-center font-mono text-xs text-os-dim">No matches — try ASK for a question.</p>
              ) : (
                <ul>
                  {hits.map((command, i) => (
                    <li key={command.id}>
                      <button
                        onClick={() => navigate(command.href)}
                        onMouseEnter={() => setIndex(i)}
                        className={`flex w-full items-center gap-2.5 rounded-sm-t px-3 py-[9px] text-left text-[13px] ${i === index ? 'bg-[var(--accent-soft)] text-os-text' : 'text-os-muted'}`}
                      >
                        <Search className="h-3 w-3 shrink-0 opacity-50" />
                        <span className="min-w-0 flex-1 truncate">{command.label}</span>
                        {command.hint && <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-os-dim">{command.hint}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {intent.lane === 'ask' && (
            <div className="px-3 py-2">
              {!answer && !asking && !askError && (
                <p className="font-mono text-[10.5px] leading-relaxed text-os-dim">
                  Press <b>Enter</b> to ask the Conductor. It answers with your current context
                  ({contextLabel}) — identifiers only, never your data.
                </p>
              )}
              {asking && <p className="font-mono text-[10.5px] text-os-dim">thinking…</p>}
              {askError && <p className="font-mono text-[10.5px] text-os-err">⚠ {askError}</p>}
              {answer && (
                <div className="space-y-1">
                  {answer.routedTo && <div className="font-mono text-[9px] uppercase tracking-wide text-os-accent">→ {answer.routedTo}</div>}
                  <p className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-os-muted">{answer.reply}</p>
                </div>
              )}
            </div>
          )}

          {intent.lane === 'do' && (
            <div className="px-1.5 py-1">
              {/* honest handling of un-actionable input */}
              {recognized?.kind === 'unknown' && !doState && (
                <p className="px-3 py-4 font-mono text-[10.5px] leading-relaxed text-os-dim">
                  Not a recognized action. IGRIS only runs a small set of typed actions
                  (run / publish / delete a workflow, approve / reject an approval, switch Hermes transport).
                </p>
              )}
              {recognized?.kind === 'missing' && !doState && (
                <div className="mx-1.5 my-1 rounded-md border border-os-border bg-os-surface2/40 p-3">
                  <div className="text-[12.5px] font-bold text-os-text">{recognized.title}</div>
                  <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-os-muted">
                    Nothing is selected for {recognized.missing.join(', ')}. Open the relevant surface, select it, then try again.
                    <b> IGRIS did not guess.</b>
                  </p>
                </div>
              )}
              {recognized?.kind === 'action' && !doState && (
                <div className="mx-1.5 my-1 rounded-md border border-os-warn/40 bg-os-warn/5 p-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-os-warn">DO · proposed</span>
                    <span className={`rounded border px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-wide ${RISK_STYLE[recognized.risk]}`}>risk {recognized.risk}</span>
                  </div>
                  <div className="mt-1 text-[12.5px] font-bold text-os-text">{recognized.title}</div>
                  <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-os-muted">
                    Press <b>Enter</b> to build a preview from live data. Nothing runs until you confirm it.
                  </p>
                </div>
              )}

              {doState?.phase === 'loading' && (
                <p className="flex items-center gap-2 px-3 py-4 font-mono text-[10.5px] text-os-dim"><Loader2 className="h-3.5 w-3.5 animate-spin" /> building preview…</p>
              )}

              {(doState?.phase === 'preview' || doState?.phase === 'executing') && (
                <PreviewCard preview={doState.preview} executing={doState.phase === 'executing'} onConfirm={() => void execute()} onCancel={() => applyDo(null)} />
              )}

              {doState?.phase === 'result' && (
                <div className={`mx-1.5 my-1 rounded-md border p-3 ${doState.result.ok ? 'border-os-ok/50 bg-os-ok/5' : 'border-os-err/50 bg-os-err/5'}`}>
                  <div className={`flex items-center gap-2 text-[12.5px] font-bold ${doState.result.ok ? 'text-os-ok' : 'text-os-err'}`}>
                    {doState.result.ok ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />} {doState.result.headline}
                  </div>
                  {doState.result.detail && <p className="mt-1 font-mono text-[10.5px] text-os-muted">{doState.result.detail}</p>}
                  {doState.result.openHref && (
                    <button onClick={() => navigate(doState.result.ok ? doState.result.openHref : undefined)} className="mt-2 inline-flex items-center gap-1.5 rounded border border-os-border px-2 py-1 font-mono text-[10px] text-os-text hover:border-os-border-strong">
                      <ExternalLink className="h-3 w-3" /> Open
                    </button>
                  )}
                </div>
              )}

              {doState?.phase === 'error' && (
                <p className="px-3 py-4 font-mono text-[10.5px] text-os-err">⚠ {doState.message}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewCard({ preview, executing, onConfirm, onCancel }: { preview: CommanderPreview; executing: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="mx-1.5 my-1 rounded-md border border-os-warn/50 bg-os-warn/5 p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-os-warn">DO · preview</span>
        <span className={`ml-auto rounded border px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-wide ${RISK_STYLE[preview.risk]}`}>risk {preview.risk}</span>
      </div>
      <div className="mt-1.5 text-[13px] font-bold text-os-text">{preview.title}</div>

      <dl className="mt-2 space-y-1">
        {preview.fields.map((f) => (
          <div key={f.label} className="flex gap-2 font-mono text-[10.5px]">
            <dt className="w-28 shrink-0 text-os-dim">{f.label}</dt>
            <dd className="min-w-0 flex-1 break-words text-os-muted">{f.value}</dd>
          </div>
        ))}
      </dl>

      {preview.effects.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {preview.effects.map((e, i) => (
            <li key={i} className="font-mono text-[10px] leading-relaxed text-os-muted">• {e}</li>
          ))}
        </ul>
      )}
      {preview.warnings.map((w, i) => (
        <p key={i} className="mt-2 flex gap-1.5 font-mono text-[10px] leading-relaxed text-os-warn"><ShieldAlert className="mt-px h-3 w-3 shrink-0" /> {w}</p>
      ))}
      {preview.blocked && preview.blockedReason && (
        <p className="mt-2 flex gap-1.5 font-mono text-[10px] leading-relaxed text-os-err"><ShieldAlert className="mt-px h-3 w-3 shrink-0" /> {preview.blockedReason}</p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={onConfirm}
          disabled={preview.blocked || executing}
          className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-[10.5px] font-bold uppercase tracking-wide transition-colors ${
            preview.blocked || executing
              ? 'cursor-not-allowed border-os-border text-os-dim'
              : 'border-os-warn/60 text-os-warn hover:bg-os-warn/10'
          }`}
        >
          {executing ? <><Loader2 className="h-3 w-3 animate-spin" /> running…</> : preview.confirmLabel}
        </button>
        <button onClick={onCancel} disabled={executing} className="rounded border border-os-border px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-wide text-os-muted hover:text-os-text disabled:cursor-not-allowed disabled:opacity-50">
          Cancel
        </button>
        {!preview.blocked && !executing && <span className="ml-auto font-mono text-[9px] text-os-dim">⌘/Ctrl+Enter</span>}
      </div>
    </div>
  );
}
