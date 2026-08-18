'use client';

/**
 * Commander Home (UX Foundation U6) — the AI-native OPERATING SURFACE.
 *
 * Briefing + Commander entry + a summary of REAL operational state — NOT an
 * analytics dashboard and NOT a second command system. It renders the
 * server-computed `HomeSnapshot` for first paint, then polls the single
 * read-only GET /api/home on a modest cadence (no-overlap). The command entry
 * only OPENS the existing U2 Commander (via the global `alex:palette` event,
 * optionally prefilled) — it never executes anything itself.
 *
 * Hydration-safe: the greeting starts from the server-computed value (matching
 * SSR) and only re-derives from LOCAL time in a mount effect (the U1 rule) — no
 * server/client mismatch. Every value shown is an identifier or safe label.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { navHrefForEvent, type ActivityEvent } from '@/lib/activity/model';
import {
  greetingForHour,
  homeSummaryLines,
  HOME_POLL_MS,
  HOME_TARGETS,
  type Greeting,
  type HomeApprovalItem,
  type HomeAttentionItem,
  type HomeHermesState,
  type HomeRunItem,
  type HomeSnapshot,
  type SummaryTone,
} from '@/lib/home/model';
import type { ApprovalRisk } from '@/lib/flows/approval-view';
import { Kbd } from '@/components/terminal';

const TONE_CLASS: Record<SummaryTone, string> = {
  warn: 'text-os-warn',
  accent: 'text-os-accent',
  err: 'text-os-err',
  dim: 'text-os-dim',
};

const RISK_TONE: Record<ApprovalRisk, string> = { low: 'text-os-ok', medium: 'text-os-warn', high: 'text-os-err' };

const HERMES_DOT: Record<HomeHermesState, string> = {
  ok: 'ok',
  warn: 'warn',
  err: 'err',
  unknown: 'off',
  stub: 'off',
};

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Coarse glyph/tone for a recent activity event (from its category/status). */
function eventGlyph(e: ActivityEvent): { glyph: string; cls: string } {
  if (e.category === 'error' || e.status === 'failed') return { glyph: '✗', cls: 'text-os-err' };
  if (e.status === 'success') return { glyph: '✓', cls: 'text-os-ok' };
  if (e.status === 'waiting_approval' || e.status === 'pending') return { glyph: '⏸', cls: 'text-os-warn' };
  return { glyph: '·', cls: 'text-os-dim' };
}

function ColumnHead({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-os-dim">{children}</div>;
}
function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="rounded-sm-t border border-os-border bg-os-surface px-3 py-2.5 font-mono text-[10.5px] text-os-dim">{children}</p>;
}

/** Open the existing Commander (optionally prefilled). One command system only. */
function openCommander(prefill?: string): void {
  window.dispatchEvent(new CustomEvent('alex:palette', { detail: prefill?.trim() ? { prefill } : undefined }));
}

export function HomeDashboard({
  initial,
  operatorName,
  serverGreeting,
}: {
  initial: HomeSnapshot;
  operatorName: string;
  serverGreeting: Greeting;
}) {
  const [snapshot, setSnapshot] = useState<HomeSnapshot>(initial);
  const [greeting, setGreeting] = useState<Greeting>(serverGreeting);
  const [entry, setEntry] = useState('');

  // Local-time greeting (mount-only) — starts from the server value so SSR and the
  // first client render match; only then does it re-derive from the browser clock.
  useEffect(() => {
    setGreeting(greetingForHour(new Date().getHours()));
  }, []);

  // Single, no-overlap poll of the one Home endpoint.
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch('/api/home');
        if (!res.ok) return;
        const body = (await res.json()) as HomeSnapshot;
        if (alive && body && Array.isArray(body.recent)) setSnapshot(body);
      } catch {
        /* transient — keep the last snapshot */
      } finally {
        inFlight = false;
      }
    };
    const id = setInterval(load, HOME_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const submitEntry = useCallback(() => {
    openCommander(entry);
    setEntry('');
  }, [entry]);

  const summary = useMemo(() => homeSummaryLines(snapshot), [snapshot]);
  const { pendingApprovals, attention, running, recent, system, firstRun } = snapshot;
  const quiet = pendingApprovals.length === 0 && attention.length === 0 && running.length === 0 && recent.length === 0;

  return (
    <div>
      {/* Greeting + briefing */}
      <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.32em] text-os-dim">// operator console</div>
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-[25px] font-bold uppercase tracking-[0.06em] text-os-text">
          {greeting}, {operatorName}
        </h1>
        <Kbd>⌘K</Kbd>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[12px]">
        {summary.map((s, i) => (
          <span key={i} className="flex items-center gap-2">
            {i > 0 && <span className="text-os-border-strong">·</span>}
            <span className={TONE_CLASS[s.tone]}>{s.text}</span>
          </span>
        ))}
      </div>

      {/* Commander entry — opens the existing Commander (prefilled). Never executes here. */}
      <div className="mt-5 flex items-center gap-2 rounded-lg-t border border-os-border-strong bg-os-surface px-4 py-3 focus-within:border-os-accent/60">
        <span className="font-mono text-[13px] text-os-dim">›</span>
        <input
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitEntry();
            }
          }}
          placeholder="What do you want IGRIS to do?"
          aria-label="Open the IGRIS Commander"
          className="min-w-0 flex-1 bg-transparent font-mono text-[13.5px] text-os-text outline-none placeholder:text-os-dim"
        />
        <button
          onClick={submitEntry}
          className="shrink-0 rounded border border-os-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-os-muted transition-colors hover:border-os-border-strong hover:text-os-text"
        >
          Command ↵
        </button>
      </div>
      <div className="mt-1.5 font-mono text-[9.5px] text-os-dim">Enter hands off to the Commander · GO navigate · ASK the Conductor · DO preview → confirm</div>

      {firstRun ? (
        <FirstMission />
      ) : (
        <>
          {/* Operational summary: Needs You · Running · Recent */}
          <div className="mt-7 grid grid-cols-3 gap-5 max-[900px]:grid-cols-1">
            {/* NEEDS YOU */}
            <section className="min-w-0">
              <ColumnHead>Needs you {pendingApprovals.length + attention.length > 0 && <span className="text-os-warn">· {pendingApprovals.length + attention.length}</span>}</ColumnHead>
              <div className="flex flex-col gap-1.5">
                {pendingApprovals.length === 0 && attention.length === 0 && <EmptyLine>No pending approvals or failures.</EmptyLine>}
                {pendingApprovals.map((a) => <ApprovalRow key={a.approvalId} item={a} />)}
                {attention.map((f) => <FailureRow key={f.runId} item={f} />)}
              </div>
            </section>

            {/* RUNNING */}
            <section className="min-w-0">
              <ColumnHead>Running {running.length > 0 && <span className="text-os-accent">· {running.length}</span>}</ColumnHead>
              <div className="flex flex-col gap-1.5">
                {running.length === 0 ? <EmptyLine>No active runs.</EmptyLine> : running.map((r) => <RunningRow key={r.runId} item={r} />)}
              </div>
            </section>

            {/* RECENT */}
            <section className="min-w-0">
              <ColumnHead>Recent</ColumnHead>
              <div className="flex flex-col gap-1.5">
                {recent.length === 0 ? (
                  <EmptyLine>No recent activity.</EmptyLine>
                ) : (
                  recent.map((e) => <RecentRow key={e.id} event={e} />)
                )}
              </div>
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('igris:activity', { detail: { filter: 'all' } }))}
                className="mt-2 font-mono text-[10px] text-os-dim transition-colors hover:text-os-accent"
              >
                View all activity →
              </button>
            </section>
          </div>

          {quiet && (
            <p className="mt-5 rounded-lg-t border border-dashed border-os-border bg-os-surface/50 px-4 py-3 text-center font-mono text-[11px] text-os-dim">
              You&apos;re all caught up. Nothing needs you, nothing is running. What do you want IGRIS to do?
            </p>
          )}
        </>
      )}

      {/* SYSTEM strip — concise, honest, from real state only */}
      <section className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg-t border border-os-border bg-os-surface px-4 py-2.5 font-mono text-[11px]">
        <div className="mr-1 text-[9.5px] uppercase tracking-[0.24em] text-os-dim">system</div>
        <Link href={HOME_TARGETS.hermes} className="flex items-center gap-1.5 hover:text-os-text" title={`Hermes: ${system.hermes.label}`}>
          <span className={`dot ${HERMES_DOT[system.hermes.state]}`} aria-hidden="true" />
          <span className="text-os-muted">Hermes</span>
          <span className="text-os-dim">{system.hermes.label}</span>
        </Link>
        <StatChip href={HOME_TARGETS.agents} label="Agents" value={system.agentCount} />
        <StatChip href={HOME_TARGETS.running} label="Active runs" value={system.activeRunCount} tone={system.activeRunCount > 0 ? 'accent' : undefined} />
        <StatChip href={HOME_TARGETS.approval} label="Approvals" value={system.pendingApprovalCount} tone={system.pendingApprovalCount > 0 ? 'warn' : undefined} />
        <StatChip href={HOME_TARGETS.failure} label="Failures" value={system.recentFailureCount} tone={system.recentFailureCount > 0 ? 'err' : undefined} />
      </section>
    </div>
  );
}

function StatChip({ href, label, value, tone }: { href: string; label: string; value: number; tone?: 'accent' | 'warn' | 'err' }) {
  const toneCls = tone === 'accent' ? 'text-os-accent' : tone === 'warn' ? 'text-os-warn' : tone === 'err' ? 'text-os-err' : 'text-os-text';
  return (
    <Link href={href} className="flex items-center gap-1.5 hover:opacity-80" title={label}>
      <span className="text-os-muted">{label}</span>
      <span className={`font-semibold ${toneCls}`}>{value}</span>
    </Link>
  );
}

function ApprovalRow({ item }: { item: HomeApprovalItem }) {
  return (
    <Link href={HOME_TARGETS.approval} className="hoverable flex items-start gap-2.5 rounded-sm-t border border-os-warn/40 bg-os-surface px-3 py-2">
      <span className="mt-px shrink-0 text-os-warn" aria-hidden="true">⏸</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-os-text">{item.title}</span>
        <span className="mt-0.5 block truncate font-mono text-[10px] text-os-dim">{item.workflowName ?? item.workflowId}</span>
      </span>
      <span className={`shrink-0 font-mono text-[9px] uppercase tracking-wide ${RISK_TONE[item.risk]}`}>{item.risk}</span>
    </Link>
  );
}

function FailureRow({ item }: { item: HomeAttentionItem }) {
  return (
    <Link href={HOME_TARGETS.failure} className="hoverable flex items-start gap-2.5 rounded-sm-t border border-os-err/40 bg-os-surface px-3 py-2">
      <span className="mt-px shrink-0 text-os-err" aria-hidden="true">✗</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-os-text">{item.workflowName ?? item.workflowId} failed</span>
        {item.detail && <span className="mt-0.5 block truncate font-mono text-[10px] text-os-dim">{item.detail}</span>}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-os-dim">{relativeTime(item.at)}</span>
    </Link>
  );
}

function RunningRow({ item }: { item: HomeRunItem }) {
  return (
    <Link href={HOME_TARGETS.running} className="hoverable flex items-center gap-2.5 rounded-sm-t border border-os-border bg-os-surface px-3 py-2">
      <span className="dot ok pulse shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-os-text">{item.workflowName ?? item.workflowId}</span>
      <span className="shrink-0 font-mono text-[10px] text-os-accent">
        Running{item.startedAt ? ` · ${relativeTime(item.startedAt)}` : ''}
      </span>
    </Link>
  );
}

function RecentRow({ event }: { event: ActivityEvent }) {
  const g = eventGlyph(event);
  return (
    <Link href={navHrefForEvent(event)} className="hoverable flex items-baseline gap-2.5 rounded-sm-t border border-os-border bg-os-surface px-3 py-2 font-mono text-[11px]">
      <span className={`shrink-0 ${g.cls}`} aria-hidden="true">{g.glyph}</span>
      <span className="min-w-0 flex-1 truncate text-os-muted">{event.title}</span>
      <span className="shrink-0 text-os-dim">{relativeTime(event.timestamp)}</span>
    </Link>
  );
}

/** Shown only when the workspace is genuinely empty — links to existing pages (no wizard). */
function FirstMission() {
  const steps: { href: string; label: string; hint: string }[] = [
    { href: '/settings', label: '1. Connect intelligence', hint: 'Pick a model / runtime' },
    { href: '/agents', label: '2. Create or open an agent', hint: 'Give it instructions + tools' },
    { href: '/flows', label: '3. Run your first workflow', hint: 'Compose nodes, publish, run' },
  ];
  return (
    <section className="mt-7">
      <ColumnHead>Start with IGRIS</ColumnHead>
      <div className="flex flex-col gap-2">
        {steps.map((s) => (
          <Link key={s.href} href={s.href} className="hoverable flex items-center gap-3 rounded-lg-t border border-os-border bg-os-surface px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold text-os-text">{s.label}</span>
              <span className="mt-0.5 block font-mono text-[10.5px] text-os-dim">{s.hint}</span>
            </span>
            <span className="shrink-0 text-os-dim">→</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
