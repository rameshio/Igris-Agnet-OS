'use client';

/**
 * Company Intelligence dashboard (Architecture V2 · F6) — a read-only analytical
 * surface over existing company state. Fetches ONE bounded snapshot API, renders a
 * health summary + explainable signals + per-domain panels, and deep-links every
 * piece of evidence to its owning canonical surface (Missions / G-Brain / Agents /
 * Flows / Approvals). It NEVER mutates: there are no action buttons here, only
 * navigation. Windowed metrics refresh on window change + a slow poll (paused
 * off-tab); nothing is ever presented as more live than "as of {generatedAt}".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CompanyIntelligenceSnapshot,
  IntelWindowKey,
  IntelligenceSignal,
  SignalEvidence,
  SignalSeverity,
} from '@/lib/company/intelligence/model';
import { Badge, type BadgeTone } from '@/components/terminal';

const WINDOWS: IntelWindowKey[] = ['1h', '24h', '7d', '30d'];
const REFRESH_MS = 20_000;

const SEVERITY_TONE: Record<SignalSeverity, BadgeTone> = { critical: 'err', warning: 'warn', info: 'default' };
const SEVERITY_BORDER: Record<SignalSeverity, string> = {
  critical: 'border-l-os-err',
  warning: 'border-l-os-warn',
  info: 'border-l-os-border-strong',
};

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function fmtRate(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n * 100)}%`;
}
function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** Deep-link a piece of evidence to its OWNING canonical surface (navigation only). */
function evidenceHref(ev: SignalEvidence): string | null {
  switch (ev.kind) {
    case 'mission':
      return `/brain?entity=mission:${ev.id}`;
    case 'company_task':
      return `/brain?entity=company_task:${ev.id}`;
    case 'agent':
      return `/brain?entity=agent:${ev.id}`;
    case 'workflow':
      return `/flows`;
    case 'approval':
      return `/approvals`;
    case 'capability':
      return `/agents`;
    default:
      return null;
  }
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'warn' | 'err' }) {
  const color = tone === 'err' ? 'text-os-err' : tone === 'warn' ? 'text-os-warn' : tone === 'ok' ? 'text-os-ok' : 'text-os-text';
  return (
    <div className="rounded-md-t border border-os-border bg-os-surface2 px-3 py-2.5">
      <div className={`font-mono text-xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-os-dim">{label}</div>
    </div>
  );
}

function Panel({ title, count, children }: { title: string; count?: string | number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col overflow-hidden rounded-lg-t border border-os-border bg-os-surface">
      <div className="flex items-center justify-between border-b border-os-border px-3.5 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-os-dim">
        <span>{title}</span>
        {count != null && <span className="text-os-muted">{count}</span>}
      </div>
      <div className="p-3.5">{children}</div>
    </section>
  );
}

function SignalCard({ signal }: { signal: IntelligenceSignal }) {
  return (
    <div className={`rounded-md-t border border-l-2 border-os-border ${SEVERITY_BORDER[signal.severity]} bg-os-surface2 px-3.5 py-3`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold">{signal.title}</span>
        <Badge tone={SEVERITY_TONE[signal.severity]}>{signal.severity}</Badge>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-os-muted">{signal.summary}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {signal.evidence.map((ev) => {
          const href = evidenceHref(ev);
          const label = ev.label ?? ev.id;
          const body = (
            <>
              <span className="text-os-dim">{ev.kind}</span> {label}
            </>
          );
          return href ? (
            <a
              key={`${ev.kind}:${ev.id}`}
              href={href}
              className="rounded-sm-t border border-os-border bg-os-surface px-1.5 py-0.5 font-mono text-[10px] text-os-muted transition-colors hover:border-os-accent hover:text-os-accent"
            >
              {body} →
            </a>
          ) : (
            <span key={`${ev.kind}:${ev.id}`} className="rounded-sm-t border border-os-border bg-os-surface px-1.5 py-0.5 font-mono text-[10px] text-os-muted">
              {body}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function CompanyIntelligence() {
  const [windowKey, setWindowKey] = useState<IntelWindowKey>('7d');
  const [snap, setSnap] = useState<CompanyIntelligenceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async (key: IntelWindowKey) => {
    if (inFlight.current) return; // no-overlap guard
    inFlight.current = true;
    setLoading(true);
    try {
      const res = await fetch(`/api/company/intelligence?window=${key}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`request failed (${res.status})`);
      const data = (await res.json()) as CompanyIntelligenceSnapshot;
      setSnap(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load intelligence');
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void load(windowKey);
  }, [windowKey, load]);

  // Slow refresh, paused while the tab is hidden, stopped on unmount.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load(windowKey);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [windowKey, load]);

  const wh = snap?.workHealth;
  const cap = snap?.capabilityHealth;
  const ex = snap?.executionHealth;
  const ap = snap?.approvalHealth;

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindowKey(w)}
              className={`rounded-sm-t border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                windowKey === w ? 'border-os-accent bg-[var(--accent-soft)] text-os-accent' : 'border-os-border text-os-dim hover:text-os-muted'
              }`}
            >
              {w}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 font-mono text-[10.5px] text-os-dim">
          {error ? (
            <span className="text-os-err">{error}</span>
          ) : snap ? (
            <span>as of {relTime(snap.generatedAt)}</span>
          ) : null}
          <button
            type="button"
            onClick={() => load(windowKey)}
            disabled={loading}
            className="rounded-sm-t border border-os-border px-2 py-1 text-os-muted transition-colors hover:border-os-accent hover:text-os-accent disabled:opacity-50"
          >
            {loading ? 'refreshing…' : 'refresh'}
          </button>
        </div>
      </div>

      {/* Health summary */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Active missions" value={wh?.activeMissions ?? '—'} />
        <Stat label="Blocked missions" value={wh?.blockedMissions ?? '—'} tone={wh && wh.blockedMissions > 0 ? 'warn' : undefined} />
        <Stat label="Waiting approval" value={ap?.tasksWaitingApproval ?? '—'} tone={ap && ap.tasksWaitingApproval > 0 ? 'warn' : undefined} />
        <Stat label="Capability gaps" value={cap?.gaps ?? '—'} tone={cap && cap.gaps > 0 ? 'err' : undefined} />
        <Stat label={`Completed · ${windowKey}`} value={wh?.completedInWindow ?? '—'} tone={wh && wh.completedInWindow > 0 ? 'ok' : undefined} />
        <Stat label={`Failed · ${windowKey}`} value={wh?.failedInWindow ?? '—'} tone={wh && wh.failedInWindow > 0 ? 'err' : undefined} />
      </div>

      {/* Signals */}
      <Panel title="Signals" count={snap ? `${snap.signals.length}` : undefined}>
        {snap && snap.signals.length > 0 ? (
          <div className="flex flex-col gap-2">
            {snap.signals.map((s) => (
              <SignalCard key={s.id} signal={s} />
            ))}
          </div>
        ) : (
          <div className="rounded-md-t border border-dashed border-os-border px-3 py-4 text-center font-mono text-[11px] text-os-dim">
            {snap ? 'No signals — nothing needs attention in this window.' : 'Loading…'}
          </div>
        )}
      </Panel>

      {/* Domain panels */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Work" count={wh ? `${wh.missions.length} missions` : undefined}>
          {wh ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                <Stat label="Queued" value={wh.queued} />
                <Stat label="Running" value={wh.running} />
                <Stat label="Wait dep" value={wh.waitingDependency} />
                <Stat label="Wait appr" value={wh.waitingApproval} />
                <Stat label="Stale" value={wh.staleTasks.length} tone={wh.staleTasks.length > 0 ? 'warn' : undefined} />
              </div>
              <div className="flex flex-col divide-y divide-os-border">
                {wh.missions.slice(0, 8).map((m) => (
                  <a key={m.missionId} href={`/brain?entity=mission:${m.missionId}`} className="group flex items-center gap-3 py-2">
                    <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-wider text-os-dim">{m.status}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] group-hover:text-os-accent">{m.title}</span>
                    <span className="shrink-0 font-mono text-[10.5px] text-os-muted tabular-nums">
                      {m.completed}/{m.total}
                      {m.failed > 0 && <span className="text-os-err"> · {m.failed}✗</span>}
                    </span>
                  </a>
                ))}
                {wh.missions.length === 0 && <span className="py-2 font-mono text-[11px] text-os-dim">No missions yet.</span>}
              </div>
            </div>
          ) : (
            <Skeleton />
          )}
        </Panel>

        <Panel title="Capabilities" count={cap ? `${cap.capabilities.length}` : undefined}>
          {cap ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Gaps" value={cap.gaps} tone={cap.gaps > 0 ? 'err' : undefined} />
                <Stat label="Single-point" value={cap.singlePoints} tone={cap.singlePoints > 0 ? 'warn' : undefined} />
                <Stat label="Healthy" value={cap.healthy} tone={cap.healthy > 0 ? 'ok' : undefined} />
              </div>
              <div className="flex flex-col divide-y divide-os-border">
                {cap.capabilities.slice(0, 8).map((c) => (
                  <div key={c.capabilityId} className="flex items-center gap-3 py-2">
                    <span
                      className={`w-20 shrink-0 font-mono text-[10px] uppercase tracking-wider ${
                        c.coverageStatus === 'gap' ? 'text-os-err' : c.coverageStatus === 'single_point' ? 'text-os-warn' : 'text-os-ok'
                      }`}
                    >
                      {c.coverageStatus === 'single_point' ? 'single' : c.coverageStatus}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{c.capabilityId}</span>
                    <span className="shrink-0 font-mono text-[10.5px] text-os-muted tabular-nums">
                      {c.eligibleAgents} agent{c.eligibleAgents === 1 ? '' : 's'} · {c.requiredByTasks} task{c.requiredByTasks === 1 ? '' : 's'}
                    </span>
                  </div>
                ))}
                {cap.capabilities.length === 0 && <span className="py-2 font-mono text-[11px] text-os-dim">No capabilities in play.</span>}
              </div>
            </div>
          ) : (
            <Skeleton />
          )}
        </Panel>

        <Panel title="Execution">
          {ex ? (
            <div className="grid grid-cols-3 gap-2">
              <Stat label={`Completed · ${windowKey}`} value={ex.tasksCompleted} tone={ex.tasksCompleted > 0 ? 'ok' : undefined} />
              <Stat label={`Failed · ${windowKey}`} value={ex.tasksFailed} tone={ex.tasksFailed > 0 ? 'err' : undefined} />
              <Stat label="Completion rate" value={fmtRate(ex.completionRate)} />
              <Stat label="Agent runs" value={ex.directAgentExecutions} />
              <Stat label="Workflow runs" value={ex.workflowExecutions} />
              <Stat label="Median duration" value={fmtDuration(ex.taskDuration.medianMs)} />
              <Stat label="Long-running" value={ex.longRunningTasks} tone={ex.longRunningTasks > 0 ? 'warn' : undefined} />
              <Stat label="WF runs" value={ex.workflowRuns} />
              <Stat label="WF failure rate" value={fmtRate(ex.workflowFailureRate)} tone={ex.workflowFailureRate && ex.workflowFailureRate >= 0.5 ? 'err' : undefined} />
            </div>
          ) : (
            <Skeleton />
          )}
        </Panel>

        <Panel title="Approvals & Agents">
          {ap && snap ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Pending" value={ap.pending} tone={ap.pending > 0 ? 'warn' : undefined} />
                <Stat label="Oldest wait" value={fmtDuration(ap.oldestPendingAgeMs)} />
                <Stat label="Avg resolve" value={fmtDuration(ap.averageResolvedWaitMs)} />
              </div>
              <div className="flex flex-col divide-y divide-os-border">
                {snap.agentHealth.slice(0, 6).map((a) => (
                  <a key={a.agentId} href={`/brain?entity=agent:${a.agentId}`} className="group flex items-center gap-3 py-2">
                    <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-wider text-os-dim">{a.currentPresence}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] group-hover:text-os-accent">{a.name}</span>
                    <span className="shrink-0 font-mono text-[10.5px] text-os-muted tabular-nums">
                      {a.activeAssignments} active · {a.completedTasks}✓ {a.failedTasks}✗
                    </span>
                  </a>
                ))}
                {snap.agentHealth.length === 0 && <span className="py-2 font-mono text-[11px] text-os-dim">No agent activity in this window.</span>}
              </div>
            </div>
          ) : (
            <Skeleton />
          )}
        </Panel>
      </div>

      <p className="font-mono text-[10px] leading-relaxed text-os-dim">
        Company Intelligence is a derived, read-only analysis over existing company state — it never becomes canonical operational
        state, never creates agents, and takes no action. Metrics shown as “—” are insufficient_data, not zero. Activity = timeline ·
        Radial = structure · Neural = operational · Intelligence = analysis.
      </p>
    </div>
  );
}

function Skeleton() {
  return <div className="h-24 animate-pulse rounded-md-t border border-dashed border-os-border" />;
}
