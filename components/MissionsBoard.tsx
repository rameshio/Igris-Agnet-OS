'use client';

/**
 * Company Missions board (Architecture V2 · F0.2). Compact admin surface over the
 * read-only + registry-mutation APIs — it never runs, delegates, or grants
 * authority. All writes go through the typed `/api/missions` + `/api/company-tasks`
 * endpoints (React never touches SQLite).
 */
import { useCallback, useEffect, useState } from 'react';
import type { Mission, CompanyTask, CompanyTaskStatus } from '@/lib/company/model';
import { COMPANY_TASK_STATUSES } from '@/lib/company/model';
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
  const [error, setError] = useState<string | null>(null);

  const selected = missions.find((m) => m.id === selectedId) ?? null;

  const loadMissions = useCallback(async () => {
    const r = await api<{ missions: Mission[] }>('/api/missions');
    if (r.data) setMissions(r.data.missions);
  }, []);

  const loadTasks = useCallback(async (missionId: string) => {
    const r = await api<{ tasks: CompanyTask[] }>(`/api/missions/${missionId}/tasks`);
    setTasks(r.data?.tasks ?? []);
  }, []);

  useEffect(() => {
    if (selectedId) void loadTasks(selectedId);
    else setTasks([]);
    setEligibleFor(null);
  }, [selectedId, loadTasks]);

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

  const setMissionStatus = async (status: string) => {
    if (!selectedId) return;
    const r = await api(`/api/missions/${selectedId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    if (await guard(r)) await loadMissions();
  };

  return (
    <div className="grid grid-cols-[300px_1fr] gap-5 max-[900px]:grid-cols-1">
      {/* Missions list */}
      <div className="min-w-0">
        <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-os-dim">Missions · {missions.length}</div>
        <div className="mb-3 flex gap-1.5">
          <input value={newMission} onChange={(e) => setNewMission(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createMission()} placeholder="New mission…" className="min-w-0 flex-1 rounded border border-os-border bg-os-bg px-2 py-1.5 font-mono text-[11px] text-os-text placeholder:text-os-dim" />
          <button onClick={createMission} className="shrink-0 rounded border border-os-border-strong px-2 py-1.5 font-mono text-[10px] uppercase text-os-muted hover:text-os-text">Add</button>
        </div>
        <div className="flex flex-col gap-1.5">
          {missions.length === 0 && <p className="rounded border border-os-border bg-os-surface px-3 py-4 text-center font-mono text-[10.5px] text-os-dim">No missions yet.</p>}
          {missions.map((m) => (
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
              <select value={selected.status} onChange={(e) => setMissionStatus(e.target.value)} className="shrink-0 rounded border border-os-border bg-os-bg px-2 py-1 font-mono text-[10px] uppercase text-os-muted">
                {['draft', 'active', 'blocked', 'completed', 'failed', 'cancelled'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

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
                        {t.requiredCapabilities.map((c) => <span key={c} className="rounded-sm-t border border-os-border bg-os-surface2 px-[6px] py-0.5 font-mono text-[9px] text-os-muted">{c}</span>)}
                      </div>
                    </div>
                    <select value={t.status} onChange={(e) => setTaskStatus(t.id, e.target.value)} className="shrink-0 rounded border border-os-border bg-os-bg px-1.5 py-1 font-mono text-[9.5px] uppercase text-os-muted">
                      {COMPANY_TASK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
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
                        <div className="font-mono text-[10px] text-os-dim">No eligible agent found. (Agent Factory arrives in F2 — F0.2 never creates one.)</div>
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
          </div>
        )}
      </div>
    </div>
  );
}
