'use client';

/**
 * Company Missions board (Architecture V2 · F0.2 + F1 + F2). Compact admin surface over
 * the typed `/api/missions` + `/api/company-tasks` endpoints (React never touches
 * SQLite). F1 adds the Executive Manager controls — Plan (decompose) and Manager
 * Step (one bounded orchestration tick) — plus per-task Dispatch, a deterministic
 * report strip (blockers / capability gaps / artifacts), and the event ledger. F2 adds
 * the Agent Factory: when a task has no eligible agent, the operator can Propose an
 * agent, then Approve/Reject it — the agent is CREATED only on approval (human-gated).
 * The board only REQUESTS these operations; the services enforce safety.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Mission, CompanyTask, CompanyTaskStatus } from '@/lib/company/model';
import { COMPANY_TASK_STATUSES } from '@/lib/company/model';
import type { MissionReport, CompanyEvent } from '@/lib/company/manager/model';
import type { AgentProposal } from '@/lib/company/factory/model';
import type { MissionCleanupPreview } from '@/lib/company/cleanup/service';
import type { AgentMatch } from '@/lib/agents/capabilities';
import { Badge } from '@/components/terminal';

type TaskStatusTone = 'ok' | 'warn' | 'err' | 'default';
const TASK_TONE: Record<CompanyTaskStatus, TaskStatusTone> = {
  queued: 'default',
  assigned: 'default',
  running: 'ok',
  waiting_dependency: 'warn',
  waiting_approval: 'warn',
  completed: 'ok',
  failed: 'err',
  cancelled: 'default',
};

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data: T | null; error?: string }> {
  try {
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    return { ok: res.ok, data: res.ok ? data : null, error: res.ok ? undefined : data?.error ?? `error ${res.status}` };
  } catch (e) {
    return { ok: false, data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export function MissionsBoard({ initialMissions }: { initialMissions: Mission[] }) {
  const [missions, setMissions] = useState<Mission[]>(initialMissions);
  const [selectedId, setSelectedId] = useState<string | null>(initialMissions[0]?.id ?? null);
  const [tasks, setTasks] = useState<CompanyTask[]>([]);
  const [newMission, setNewMission] = useState('');
  const [newTask, setNewTask] = useState('');
  const [newTaskCaps, setNewTaskCaps] = useState('');
  const [eligibleFor, setEligibleFor] = useState<{ taskId: string; agents: AgentMatch[] } | null>(null);
  const [report, setReport] = useState<MissionReport | null>(null);
  const [events, setEvents] = useState<CompanyEvent[]>([]);
  const [proposals, setProposals] = useState<AgentProposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const selected = missions.find((m) => m.id === selectedId) ?? null;
  // Archived missions are hidden from the default view (kept, not deleted).
  const visibleMissions = missions.filter((m) => showArchived || m.status !== 'archived');

  const loadMissions = useCallback(async () => {
    const r = await api<{ missions: Mission[] }>('/api/missions');
    if (r.data) setMissions(r.data.missions);
  }, []);

  const loadDetail = useCallback(async (missionId: string) => {
    const [t, rep, ev, pr] = await Promise.all([
      api<{ tasks: CompanyTask[] }>(`/api/missions/${missionId}/tasks`),
      api<{ report: MissionReport }>(`/api/missions/${missionId}/report`),
      api<{ events: CompanyEvent[] }>(`/api/missions/${missionId}/events`),
      api<{ proposals: AgentProposal[] }>(`/api/missions/${missionId}/proposals`),
    ]);
    setTasks(t.data?.tasks ?? []);
    setReport(rep.data?.report ?? null);
    setEvents(ev.data?.events ?? []);
    setProposals(pr.data?.proposals ?? []);
  }, []);
  const loadTasks = loadDetail;

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else {
      setTasks([]);
      setReport(null);
      setEvents([]);
      setProposals([]);
    }
    setEligibleFor(null);
  }, [selectedId, loadDetail]);

  const guard = async (r: { ok: boolean; error?: string }) => {
    setError(r.ok ? null : r.error ?? 'error');
    return r.ok;
  };

  const createMission = async () => {
    if (!newMission.trim()) return;
    const r = await api<{ mission: Mission }>('/api/missions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newMission.trim() }) });
    if (await guard(r)) {
      setNewMission('');
      await loadMissions();
      if (r.data?.mission) setSelectedId(r.data.mission.id);
    }
  };

  const createTask = async () => {
    if (!selectedId || !newTask.trim()) return;
    const requiredCapabilities = newTaskCaps.split(',').map((c) => c.trim()).filter(Boolean);
    const r = await api(`/api/missions/${selectedId}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newTask.trim(), requiredCapabilities }) });
    if (await guard(r)) {
      setNewTask('');
      setNewTaskCaps('');
      await loadTasks(selectedId);
      await loadMissions();
    }
  };

  const setTaskStatus = async (taskId: string, status: string) => {
    const r = await api(`/api/company-tasks/${taskId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    if ((await guard(r)) && selectedId) await loadTasks(selectedId);
  };

  const showEligible = async (taskId: string) => {
    if (eligibleFor?.taskId === taskId) return setEligibleFor(null);
    const r = await api<{ agents: AgentMatch[] }>(`/api/company-tasks/${taskId}/eligible-agents`);
    if (await guard(r)) setEligibleFor({ taskId, agents: r.data?.agents ?? [] });
  };

  const assign = async (taskId: string, agentId: string) => {
    const r = await api(`/api/company-tasks/${taskId}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId }) });
    if ((await guard(r)) && selectedId) {
      setEligibleFor(null);
      await loadTasks(selectedId);
    }
  };

  const addDependency = async (taskId: string, dependsOnTaskId: string) => {
    if (!dependsOnTaskId) return;
    const r = await api(`/api/company-tasks/${taskId}/dependencies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dependsOnTaskId }) });
    if ((await guard(r)) && selectedId) await loadTasks(selectedId);
  };

  // ── F1 Executive Manager operations (request only; the service enforces safety) ──
  const runManager = async (path: string, key: string) => {
    if (!selectedId) return;
    setBusy(key);
    const r = await api(`/api/missions/${selectedId}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setBusy(null);
    if (await guard(r)) {
      await loadDetail(selectedId);
      await loadMissions();
    }
  };
  const planMission = () => runManager('plan', 'plan');
  const managerStep = () => runManager('manager-step', 'step');
  const dispatch = async (taskId: string) => {
    setBusy(taskId);
    const r = await api(`/api/company-tasks/${taskId}/dispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setBusy(null);
    if ((await guard(r)) && selectedId) await loadDetail(selectedId);
  };

  // ── F2 Agent Factory (operator-triggered; agent CREATED only on approval) ──
  const proposeAgent = async (taskId: string) => {
    setBusy(taskId);
    const r = await api(`/api/company-tasks/${taskId}/propose-agent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setBusy(null);
    if ((await guard(r)) && selectedId) {
      setEligibleFor(null);
      await loadDetail(selectedId);
    }
  };
  const decideProposal = async (proposalId: string, decision: 'approve' | 'reject') => {
    setBusy(proposalId);
    const r = await api(`/api/agent-proposals/${proposalId}/${decision}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setBusy(null);
    if ((await guard(r)) && selectedId) await loadDetail(selectedId);
  };

  const setMissionStatus = async (status: string) => {
    if (!selectedId) return;
    const r = await api(`/api/missions/${selectedId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    if (await guard(r)) await loadMissions();
  };

  // ── Cleanup seam (consolidation): archive (lifecycle-safe) + delete-test (U3 preview→confirm) ──
  const archiveMission = async () => {
    if (!selectedId) return;
    setBusy('archive');
    const r = await api(`/api/missions/${selectedId}/archive`, { method: 'POST' });
    setBusy(null);
    if (await guard(r)) await loadMissions();
  };

  const deleteMission = async () => {
    if (!selectedId) return;
    const p = await api<MissionCleanupPreview>(`/api/missions/${selectedId}/cleanup-preview`);
    if (!(await guard(p)) || !p.data) return;
    const d = p.data;
    const msg = [
      `Delete test mission "${d.title}"? This cannot be undone.`,
      ``,
      `Removes (mission-owned only): ${d.willDelete.tasks} tasks · ${d.willDelete.dependencies} deps · ${d.willDelete.artifacts} artifacts · ${d.willDelete.events} events · ${d.willDelete.proposals} proposals`,
      `Retires (not deleted): ${d.temporaryAgentsToRetire.length} temporary agent(s)`,
      `Preserved untouched: ${d.preserved.sharedAgents.length} shared agent(s) · ${d.preserved.workflows.length} workflow(s) · ${d.preserved.durableKnowledgeUntouched} knowledge item(s)`,
    ].join('\n');
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;
    setBusy('delete');
    const r = await api(`/api/missions/${selectedId}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    setBusy(null);
    if (await guard(r)) {
      setSelectedId(null);
      await loadMissions();
    }
  };

  // ── F3 G-Brain: explicit artifact → knowledge promotion (never automatic) ──
  const promoteArtifact = async (artifactId: string) => {
    setBusy(artifactId);
    const r = await api(`/api/company-artifacts/${artifactId}/promote-to-brain`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setBusy(null);
    if ((await guard(r)) && selectedId) await loadDetail(selectedId);
  };

  return (
    <div className="grid grid-cols-[300px_1fr] gap-5 max-[900px]:grid-cols-1">
      {/* Missions list */}
      <div className="min-w-0">
        <div className="mb-2 flex items-center justify-between font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-os-dim">
          <span>Missions · {visibleMissions.length}</span>
          {missions.some((m) => m.status === 'archived') && (
            <button onClick={() => setShowArchived((v) => !v)} className="tracking-normal text-os-dim transition-colors hover:text-os-accent">{showArchived ? 'hide archived' : 'show archived'}</button>
          )}
        </div>
        <div className="mb-3 flex gap-1.5">
          <input value={newMission} onChange={(e) => setNewMission(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createMission()} placeholder="New mission…" className="min-w-0 flex-1 rounded border border-os-border bg-os-bg px-2 py-1.5 font-mono text-[11px] text-os-text placeholder:text-os-dim" />
          <button onClick={createMission} className="shrink-0 rounded border border-os-border-strong px-2 py-1.5 font-mono text-[10px] uppercase text-os-muted hover:text-os-text">Add</button>
        </div>
        <div className="flex flex-col gap-1.5">
          {visibleMissions.length === 0 && <p className="rounded border border-os-border bg-os-surface px-3 py-4 text-center font-mono text-[10.5px] text-os-dim">No missions yet.</p>}
          {visibleMissions.map((m) => (
            <button key={m.id} onClick={() => setSelectedId(m.id)} className={`rounded-sm-t border px-3 py-2 text-left transition-colors ${selectedId === m.id ? 'border-os-accent/50 bg-os-surface2' : 'border-os-border bg-os-surface hover:border-os-border-strong'}`}>
              <div className="truncate text-[12.5px] font-semibold text-os-text">{m.title}</div>
              <div className="mt-0.5 font-mono text-[9.5px] uppercase tracking-wide text-os-dim">{m.status} · {m.priority}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Mission detail */}
      <div className="min-w-0">
        {error && <div className="mb-3 rounded border border-os-err/50 bg-os-err/5 px-3 py-2 font-mono text-[10.5px] text-os-err">⚠ {error}</div>}
        {!selected ? (
          <p className="rounded-lg-t border border-os-border bg-os-surface px-4 py-10 text-center font-mono text-[12px] text-os-dim">Select or create a mission.</p>
        ) : (
          <div>
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-[16px] font-bold text-os-text">{selected.title}</h2>
              <div className="flex shrink-0 items-center gap-2">
                <a href={`/brain?entity=mission:${selected.id}`} className="rounded border border-os-border px-2 py-1 font-mono text-[9.5px] uppercase text-os-dim hover:border-os-accent/50 hover:text-os-accent" title="View this mission's structure in G-Brain">View in G-Brain</a>
                {selected.status !== 'archived' ? (
                  <button onClick={archiveMission} disabled={busy === 'archive'} className="rounded border border-os-border px-2 py-1 font-mono text-[9.5px] uppercase text-os-dim hover:border-os-warn/50 hover:text-os-warn disabled:opacity-50" title="Hide from the default view; keeps everything">{busy === 'archive' ? '…' : 'Archive'}</button>
                ) : (
                  <span className="rounded border border-os-border px-2 py-1 font-mono text-[9.5px] uppercase text-os-dim">archived</span>
                )}
                <button onClick={deleteMission} disabled={busy === 'delete'} className="rounded border border-os-err/40 px-2 py-1 font-mono text-[9.5px] uppercase text-os-err hover:bg-os-err/10 disabled:opacity-50" title="Delete this test mission and its owned records (preview → confirm); shared agents/workflows/knowledge are preserved">{busy === 'delete' ? 'deleting…' : 'Delete test'}</button>
                <select value={selected.status === 'archived' ? 'archived' : selected.status} onChange={(e) => setMissionStatus(e.target.value)} disabled={selected.status === 'archived'} className="rounded border border-os-border bg-os-bg px-2 py-1 font-mono text-[10px] uppercase text-os-muted disabled:opacity-60">
                  {['draft', 'active', 'blocked', 'completed', 'failed', 'cancelled'].map((s) => <option key={s} value={s}>{s}</option>)}
                  {selected.status === 'archived' && <option value="archived">archived</option>}
                </select>
              </div>
            </div>

            {/* F1 Executive Manager controls + deterministic report strip */}
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-sm-t border border-os-border bg-os-surface px-3 py-2">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-os-accent">manager</span>
              <button onClick={planMission} disabled={busy === 'plan'} className="rounded border border-os-border-strong px-2 py-1 font-mono text-[10px] uppercase text-os-muted hover:text-os-text disabled:opacity-50">{busy === 'plan' ? 'planning…' : 'Plan mission'}</button>
              <button onClick={managerStep} disabled={busy === 'step'} className="rounded border border-os-accent/50 px-2 py-1 font-mono text-[10px] uppercase text-os-accent hover:bg-os-accent/10 disabled:opacity-50">{busy === 'step' ? 'stepping…' : 'Manager step'}</button>
              {report && (
                <span className="ml-auto flex flex-wrap items-center gap-2.5 font-mono text-[10px] text-os-dim">
                  <span>{report.taskCounts.completed}/{report.taskCounts.total} done</span>
                  {report.taskCounts.running > 0 && <span className="text-os-ok">{report.taskCounts.running} running</span>}
                  {report.taskCounts.failed > 0 && <span className="text-os-err">{report.taskCounts.failed} failed</span>}
                  {report.capabilityGaps.length > 0 && <span className="text-os-warn">{report.capabilityGaps.length} cap-gap</span>}
                  <span>{report.artifacts.length} artifact{report.artifacts.length === 1 ? '' : 's'}</span>
                </span>
              )}
            </div>
            {report && report.blockers.length > 0 && (
              <div className="mt-2 rounded-sm-t border border-os-warn/40 bg-os-warn/5 px-3 py-1.5 font-mono text-[10px] text-os-warn">
                Blockers: {report.blockers.map((b) => `${b.title} (${b.reason.replace('_', ' ')})`).join(' · ')}
              </div>
            )}

            {/* F3 — explicitly promote an artifact into durable G-Brain knowledge (never automatic) */}
            {report && report.artifacts.length > 0 && (
              <div className="mt-2 rounded-sm-t border border-os-border bg-os-surface px-3 py-2">
                <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-os-dim">Artifacts · {report.artifacts.length}</div>
                <div className="flex flex-col gap-1">
                  {report.artifacts.slice(0, 8).map((a) => (
                    <div key={a.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-mono text-[10px] text-os-muted">{a.title} <span className="text-os-dim">· {a.type}</span></span>
                      <button onClick={() => promoteArtifact(a.id)} disabled={busy === a.id} className="shrink-0 rounded border border-os-accent/50 px-2 py-0.5 font-mono text-[9px] uppercase text-os-accent hover:bg-os-accent/10 disabled:opacity-40" title="Promote this artifact into durable G-Brain knowledge with provenance">
                        {busy === a.id ? '…' : 'Promote to G-Brain'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* New task */}
            <div className="mt-4 mb-3 flex flex-wrap gap-1.5">
              <input value={newTask} onChange={(e) => setNewTask(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createTask()} placeholder="New task title…" className="min-w-[160px] flex-1 rounded border border-os-border bg-os-bg px-2 py-1.5 font-mono text-[11px] text-os-text placeholder:text-os-dim" />
              <input value={newTaskCaps} onChange={(e) => setNewTaskCaps(e.target.value)} placeholder="required caps e.g. research.web,research.market" className="min-w-[200px] flex-[2] rounded border border-os-border bg-os-bg px-2 py-1.5 font-mono text-[10.5px] text-os-text placeholder:text-os-dim" />
              <button onClick={createTask} className="shrink-0 rounded border border-os-border-strong px-2.5 py-1.5 font-mono text-[10px] uppercase text-os-muted hover:text-os-text">Add task</button>
            </div>

            <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-os-dim">Tasks · {tasks.length}</div>
            <div className="flex flex-col gap-2">
              {tasks.length === 0 && <p className="rounded border border-os-border bg-os-surface px-3 py-4 text-center font-mono text-[10.5px] text-os-dim">No tasks yet.</p>}
              {tasks.map((t) => (
                <div key={t.id} className="rounded-sm-t border border-os-border bg-os-surface p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px] font-semibold text-os-text">{t.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone={TASK_TONE[t.status]}>{t.status.replace('_', ' ')}</Badge>
                        {t.assignedAgentId && <span className="font-mono text-[9.5px] text-os-dim">→ {t.assignedAgentId}</span>}
                        {t.executionKind && <span className="font-mono text-[9px] uppercase text-os-dim">[{t.executionKind}]</span>}
                        {t.requiredCapabilities.map((c) => <span key={c} className="rounded-sm-t border border-os-border bg-os-surface2 px-[6px] py-0.5 font-mono text-[9px] text-os-muted">{c}</span>)}
                      </div>
                    </div>
                    <select value={t.status} onChange={(e) => setTaskStatus(t.id, e.target.value)} className="shrink-0 rounded border border-os-border bg-os-bg px-1.5 py-1 font-mono text-[9.5px] uppercase text-os-muted">
                      {COMPANY_TASK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button onClick={() => dispatch(t.id)} disabled={busy === t.id || ['running', 'completed', 'cancelled'].includes(t.status)} className="rounded border border-os-accent/50 px-2 py-0.5 font-mono text-[9.5px] text-os-accent hover:bg-os-accent/10 disabled:opacity-40" title="Ask the Manager to dispatch this task to an agent/workflow">
                      {busy === t.id ? '…' : 'Dispatch'}
                    </button>
                    <button onClick={() => showEligible(t.id)} className="rounded border border-os-border px-2 py-0.5 font-mono text-[9.5px] text-os-muted hover:text-os-text">
                      {eligibleFor?.taskId === t.id ? 'Hide eligible' : 'Eligible agents'}
                    </button>
                    {tasks.length > 1 && (
                      <select defaultValue="" onChange={(e) => { void addDependency(t.id, e.target.value); e.currentTarget.value = ''; }} className="rounded border border-os-border bg-os-bg px-1.5 py-0.5 font-mono text-[9.5px] text-os-dim">
                        <option value="">depends on…</option>
                        {tasks.filter((o) => o.id !== t.id).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                      </select>
                    )}
                  </div>

                  {eligibleFor?.taskId === t.id && (
                    <div className="mt-2 rounded border border-os-border bg-os-bg p-2">
                      {eligibleFor.agents.length === 0 ? (
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 font-mono text-[10px] text-os-dim">No eligible agent. The Agent Factory (F2) can propose one — created only on approval.</div>
                          {t.requiredCapabilities.length > 0 && (
                            <button onClick={() => proposeAgent(t.id)} disabled={busy === t.id} className="shrink-0 rounded border border-os-accent/50 px-2 py-0.5 font-mono text-[9.5px] text-os-accent hover:bg-os-accent/10 disabled:opacity-40" title="Ask the Agent Factory to propose an agent that fills this gap (human-approved)">
                              {busy === t.id ? '…' : 'Propose agent'}
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {eligibleFor.agents.map((a) => (
                            <div key={a.agentId} className="flex items-center justify-between gap-2 font-mono text-[10px]">
                              <span className="min-w-0 truncate text-os-muted">{a.name} <span className="text-os-dim">· {a.matchedCapabilities.join(', ')}{a.proficiency != null ? ` · ${a.proficiency}` : ''}</span></span>
                              <button onClick={() => assign(t.id, a.agentId)} className="shrink-0 rounded border border-os-ok/50 px-2 py-0.5 text-os-ok hover:bg-os-ok/10">Assign</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* F2 Agent Factory — proposals awaiting a human decision (create only on approval) */}
            {proposals.length > 0 && (
              <div className="mt-5">
                <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-os-dim">Agent proposals · {proposals.length}</div>
                <div className="flex flex-col gap-2">
                  {proposals.map((p) => (
                    <div key={p.id} className="rounded-sm-t border border-os-border bg-os-surface p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[12px] font-semibold text-os-text">{p.spec.name}</span>
                            <Badge tone={p.status === 'approved' ? 'ok' : p.status === 'rejected' ? 'err' : 'warn'}>{p.status}</Badge>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {p.requiredCapabilities.map((c) => <span key={c} className="rounded-sm-t border border-os-border bg-os-surface2 px-[6px] py-0.5 font-mono text-[9px] text-os-muted">{c}</span>)}
                            {p.spec.tools.map((tool) => <span key={tool} className="font-mono text-[9px] text-os-dim">·{tool}</span>)}
                            {p.status === 'approved' && p.agentId && <span className="font-mono text-[9px] text-os-ok">→ {p.agentId}</span>}
                          </div>
                          {p.rationale && <div className="mt-1 line-clamp-2 font-mono text-[9.5px] text-os-dim">{p.rationale}</div>}
                        </div>
                        {p.status === 'pending' && (
                          <div className="flex shrink-0 gap-1.5">
                            <button onClick={() => decideProposal(p.id, 'approve')} disabled={busy === p.id} className="rounded border border-os-ok/50 px-2 py-0.5 font-mono text-[9.5px] uppercase text-os-ok hover:bg-os-ok/10 disabled:opacity-40">Approve</button>
                            <button onClick={() => decideProposal(p.id, 'reject')} disabled={busy === p.id} className="rounded border border-os-err/50 px-2 py-0.5 font-mono text-[9.5px] uppercase text-os-err hover:bg-os-err/10 disabled:opacity-40">Reject</button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* F1 event ledger (append-only; safe metadata only) */}
            {events.length > 0 && (
              <div className="mt-5">
                <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-os-dim">Events · {events.length}</div>
                <ul className="flex flex-col gap-1">
                  {events.slice(0, 12).map((e) => (
                    <li key={e.id} className="flex items-baseline gap-2 rounded-sm-t border border-os-border bg-os-surface px-2.5 py-1 font-mono text-[9.5px]">
                      <span className="shrink-0 uppercase tracking-wide text-os-accent">{e.type}</span>
                      <span className="min-w-0 flex-1 truncate text-os-muted">{e.summary}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
