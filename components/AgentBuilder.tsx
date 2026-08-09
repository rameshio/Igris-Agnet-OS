'use client';

/**
 * The agent builder: the client-facing surface for creating and customizing
 * agents. A form POSTs to /api/agents; each saved agent gets Run / Edit /
 * Delete. This is what turns the OS from a fixed demo roster into something a
 * client can shape — data-driven agents backed by lib/agents/custom.ts.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Pencil, Play, X, Loader2, Wrench } from 'lucide-react';
import type { CustomAgent } from '@/lib/schemas';
import { parseModelSettings, serializeModelSettings } from '@/lib/models/settings';
import type { AgentModelSettings, ModelStrategy } from '@/lib/models/types';

type DeptOption = { id: string; name: string };
type ToolOption = { slug: string; name: string; category: string; wired: boolean };
type ProviderInfo = { id: string; name: string; connected: boolean; enabled?: boolean; models: string[]; local?: boolean };

type FormState = {
  name: string;
  departmentId: string;
  instructions: string;
  model: string;
  tools: string[];
  enabled: boolean;
};

const EMPTY = (deptId: string): FormState => ({
  name: '',
  departmentId: deptId,
  instructions: '',
  model: '',
  tools: [],
  enabled: true,
});

const inputClass =
  'min-w-0 flex-1 rounded border border-os-border bg-os-bg px-2 py-1.5 text-[12px] text-os-text placeholder:text-os-dim focus:border-os-border-bright focus:outline-none';

// The tool picker: search the catalog, click to connect. Wired tools (a real
// capability exists) are marked "live"; the rest are recorded but inert.
function AgentToolPicker({
  tools,
  selected,
  onToggle,
}: {
  tools: ToolOption[];
  selected: string[];
  onToggle: (slug: string) => void;
}) {
  const [query, setQuery] = useState('');
  const bySlug = useMemo(() => new Map(tools.map((t) => [t.slug, t])), [tools]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return tools.filter((t) => t.name.toLowerCase().includes(q) || t.slug.includes(q)).slice(0, 8);
  }, [tools, query]);

  return (
    <div>
      <div className="mb-1 flex flex-wrap gap-1">
        {selected.map((slug) => {
          const t = bySlug.get(slug);
          return (
            <span
              key={slug}
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                t?.wired ? 'border-os-ok/40 bg-os-surface2 text-os-text' : 'border-os-border bg-os-surface2 text-os-muted'
              }`}
            >
              {t?.name ?? slug}
              {t?.wired ? <span className="text-os-ok" title="Live capability">●</span> : <span className="text-os-dim" title="Recorded, not yet wired">○</span>}
              <button onClick={() => onToggle(slug)} className="text-os-dim hover:text-os-err" aria-label={`Remove ${slug}`}>
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          );
        })}
        {selected.length === 0 && <span className="font-mono text-[10px] text-os-dim">no tools connected</span>}
      </div>
      <div className="relative">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Connect a tool… (Slack, Gmail, Notion, Telegram, Stripe, Attio…)"
          className={`${inputClass} text-[11px]`}
        />
        {matches.length > 0 && (
          <div className="absolute z-10 mt-1 w-full overflow-hidden rounded border border-os-border bg-os-bg shadow-lg">
            {matches.map((t) => (
              <button
                key={t.slug}
                onClick={() => {
                  onToggle(t.slug);
                  setQuery('');
                }}
                className="flex w-full items-center justify-between px-2 py-1.5 text-left text-[11px] hover:bg-os-surface2"
              >
                <span className="text-os-text">{t.name}</span>
                <span className="font-mono text-[9px] text-os-dim">
                  {selected.includes(t.slug) ? '✓ connected' : t.wired ? 'live' : t.category}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="mt-1 text-[9.5px] leading-relaxed text-os-dim">
        <span className="text-os-ok">●</span> live = the agent can really call it · <span className="text-os-dim">○</span> recorded, capability not wired yet
      </p>
    </div>
  );
}

/** Fixed / Hermes / Auto strategy + provider/model dropdowns (Phase B). */
function ModelStrategyPicker({
  settings,
  providers,
  onChange,
}: {
  settings: AgentModelSettings;
  providers: ProviderInfo[];
  onChange: (s: AgentModelSettings) => void;
}) {
  const available = providers.filter((p) => p.connected && p.enabled !== false);
  const current = providers.find((p) => p.id === settings.config.providerId);
  const modelOptions = (() => {
    const list = current?.models ?? [];
    const sel = settings.config.modelId;
    return sel && !list.includes(sel) ? [sel, ...list] : list;
  })();
  const strat = settings.strategy;
  const pick = (strategy: ModelStrategy) =>
    onChange({ strategy, config: strategy === 'fixed' ? (settings.config.providerId ? settings.config : {}) : {} });

  return (
    <div className="w-full rounded border border-os-border bg-os-bg p-2.5">
      <div className="text-[9px] uppercase tracking-[0.2em] text-os-dim">Model strategy</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {(['fixed', 'hermes', 'auto'] as ModelStrategy[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => pick(s)}
            className={`rounded px-2.5 py-1 text-[11px] font-semibold transition-colors ${
              strat === s ? 'border border-os-border-bright bg-os-text text-os-bg' : 'border border-os-border text-os-muted hover:text-os-text'
            }`}
          >
            {s === 'fixed' ? 'Fixed model' : s === 'hermes' ? 'Hermes' : 'Auto'}
          </button>
        ))}
      </div>

      {strat === 'fixed' &&
        (available.length === 0 ? (
          <p className="mt-2 font-mono text-[10.5px] text-os-dim">
            No connected providers — connect one on{' '}
            <a href="/models" className="underline underline-offset-2">
              /models
            </a>
            .
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            <select
              value={settings.config.providerId ?? ''}
              onChange={(e) => onChange({ strategy: 'fixed', config: { providerId: e.target.value || undefined, modelId: undefined } })}
              className="rounded border border-os-border bg-os-surface px-2 py-1 text-[11px] text-os-text focus:border-os-border-bright focus:outline-none"
            >
              <option value="">Provider…</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={settings.config.modelId ?? ''}
              disabled={!current}
              onChange={(e) => onChange({ strategy: 'fixed', config: { providerId: settings.config.providerId, modelId: e.target.value || undefined } })}
              className="min-w-[170px] rounded border border-os-border bg-os-surface px-2 py-1 font-mono text-[11px] text-os-text focus:border-os-border-bright focus:outline-none disabled:opacity-50"
            >
              <option value="">{current && modelOptions.length === 0 ? 'No models — Refresh on /models' : 'Model…'}</option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        ))}
      {strat === 'hermes' && <p className="mt-2 font-mono text-[10.5px] text-os-muted">Runs on Hermes — your default brain (tools · MCP · memory).</p>}
      {strat === 'auto' && (
        <p className="mt-2 font-mono text-[10.5px] text-os-warn">
          Auto routing is not fully available yet — it will not intelligently pick a model. Choose Fixed or Hermes to run now.
        </p>
      )}
    </div>
  );
}

export function AgentBuilder({
  departments,
  tools,
  initialAgents,
}: {
  departments: DeptOption[];
  tools: ToolOption[];
  initialAgents: CustomAgent[];
}) {
  const firstDept = departments[0]?.id ?? '';
  const [agents, setAgents] = useState<CustomAgent[]>(initialAgents);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY(firstDept));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runResults, setRunResults] = useState<Record<string, { ok: boolean; summary: string }>>({});
  const [runningId, setRunningId] = useState<string | null>(null);
  // Connected model providers (for the Fixed-strategy provider/model dropdowns).
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  useEffect(() => {
    fetch('/api/models')
      .then((r) => r.json())
      .then((j: { providers?: ProviderInfo[] }) => setProviders(j.providers ?? []))
      .catch(() => setProviders([]));
  }, []);

  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? id;
  const toolBySlug = useMemo(() => new Map(tools.map((t) => [t.slug, t])), [tools]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY(firstDept));
    setError(null);
    setShowForm(true);
  };

  const openEdit = (agent: CustomAgent) => {
    setEditingId(agent.id);
    setForm({
      name: agent.name,
      departmentId: agent.departmentId,
      instructions: agent.instructions,
      model: agent.model,
      tools: agent.tools,
      enabled: agent.enabled,
    });
    setError(null);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setError(null);
  };

  const submit = async () => {
    if (!form.name.trim() || !form.instructions.trim()) {
      setError('Name and instructions are required.');
      return;
    }
    setBusy(true);
    setError(null);
    const editing = editingId !== null;
    const res = await fetch(editing ? `/api/agents/${editingId}` : '/api/agents', {
      method: editing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name.trim(),
        departmentId: form.departmentId,
        instructions: form.instructions.trim(),
        model: form.model.trim(),
        tools: form.tools,
        enabled: form.enabled,
      }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    setBusy(false);
    if (!res || !res.ok) {
      setError((json && json.error) || 'Save failed.');
      return;
    }
    const saved: CustomAgent = json.agent;
    setAgents((prev) => (editing ? prev.map((a) => (a.id === saved.id ? saved : a)) : [saved, ...prev]));
    closeForm();
  };

  const toggleEnabled = async (agent: CustomAgent) => {
    const res = await fetch(`/api/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !agent.enabled }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok && json.agent) {
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? json.agent : a)));
    }
  };

  const remove = async (agent: CustomAgent) => {
    const res = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' }).catch(() => null);
    if (res?.ok) {
      setAgents((prev) => prev.filter((a) => a.id !== agent.id));
      setRunResults((prev) => {
        const next = { ...prev };
        delete next[agent.id];
        return next;
      });
    }
  };

  const run = async (agent: CustomAgent) => {
    setRunningId(agent.id);
    const res = await fetch(`/api/agents/${agent.id}/run`, { method: 'POST' }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    setRunningId(null);
    if (res?.ok && json.run) {
      setRunResults((prev) => ({ ...prev, [agent.id]: { ok: json.run.ok, summary: json.run.summary } }));
    } else {
      setRunResults((prev) => ({
        ...prev,
        [agent.id]: { ok: false, summary: (json && json.error) || 'Run failed.' },
      }));
    }
  };

  return (
    <section className="mb-8 rounded-lg-t border border-os-border bg-os-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.26em] text-os-dim">// your agents</div>
          <h2 className="mt-1 text-[15px] font-bold">Custom Agents</h2>
          <p className="mt-0.5 text-[11.5px] text-os-muted">
            Create and customize your own agents. Each runs on the OS model with the instructions you give it.
          </p>
        </div>
        {!showForm && (
          <button
            onClick={openCreate}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-os-border-bright bg-os-text px-3 py-2 text-[12px] font-semibold text-os-bg hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" /> New Agent
          </button>
        )}
      </div>

      {showForm && (
        <div className="mt-4 rounded-md border border-os-border bg-os-bg p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-[0.2em] text-os-dim">
              {editingId ? 'Edit agent' : 'New agent'}
            </div>
            <button onClick={closeForm} className="text-os-dim hover:text-os-text" aria-label="Close form">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-2.5">
            <div className="flex flex-wrap gap-2">
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Agent name (e.g. Lead Qualifier)"
                className={inputClass}
              />
              <select
                value={form.departmentId}
                onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value }))}
                className="shrink-0 rounded border border-os-border bg-os-bg px-2 py-1.5 text-[12px] text-os-text focus:border-os-border-bright focus:outline-none"
              >
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>

            <textarea
              value={form.instructions}
              onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
              placeholder="Instructions — what this agent is and how it should behave. This is its system prompt."
              rows={4}
              className={`${inputClass} w-full resize-y leading-relaxed`}
            />

            <ModelStrategyPicker
              settings={parseModelSettings(form.model)}
              providers={providers}
              onChange={(next) => setForm((f) => ({ ...f, model: serializeModelSettings(next) }))}
            />

            <div className="flex flex-wrap items-center gap-3">
              <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-os-muted">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                />
                Enabled
              </label>
            </div>

            <div>
              <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-os-dim">
                <Wrench className="h-3 w-3" /> Tools this agent can use
              </div>
              <AgentToolPicker
                tools={tools}
                selected={form.tools}
                onToggle={(slug) =>
                  setForm((f) => ({
                    ...f,
                    tools: f.tools.includes(slug) ? f.tools.filter((s) => s !== slug) : [...f.tools, slug],
                  }))
                }
              />
            </div>

            {error && <p className="font-mono text-[10.5px] text-os-err">✗ {error}</p>}

            <div className="flex items-center gap-2">
              <button
                onClick={submit}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-md border border-os-border-bright bg-os-text px-3 py-1.5 text-[12px] font-semibold text-os-bg hover:opacity-90 disabled:opacity-50"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {editingId ? 'Save changes' : 'Create agent'}
              </button>
              <button onClick={closeForm} className="rounded-md border border-os-border px-3 py-1.5 text-[12px] text-os-muted hover:text-os-text">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => {
          const result = runResults[agent.id];
          return (
            <article key={agent.id} className="flex flex-col rounded-md border border-os-border bg-os-bg p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-[13.5px] font-bold">{agent.name}</h3>
                  <div className="mt-0.5 font-mono text-[10px] text-os-dim">{deptName(agent.departmentId)}</div>
                </div>
                <button
                  onClick={() => toggleEnabled(agent)}
                  title={agent.enabled ? 'Disable' : 'Enable'}
                  className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                    agent.enabled ? 'bg-os-text text-os-bg' : 'border border-os-border text-os-dim'
                  }`}
                >
                  {agent.enabled ? 'on' : 'off'}
                </button>
              </div>

              <p className="mt-2 line-clamp-3 text-[11.5px] leading-relaxed text-os-muted [text-wrap:pretty]">
                {agent.instructions}
              </p>

              {agent.tools.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <Wrench className="h-2.5 w-2.5 text-os-dim" />
                  {agent.tools.map((slug) => {
                    const t = toolBySlug.get(slug);
                    return (
                      <span
                        key={slug}
                        className="rounded border border-os-border px-1.5 py-0.5 font-mono text-[9px] text-os-muted"
                        title={t?.wired ? 'Live capability' : 'Recorded, not yet wired'}
                      >
                        {t?.name ?? slug}
                        {t?.wired && <span className="ml-1 text-os-ok">●</span>}
                      </span>
                    );
                  })}
                </div>
              )}

              {result && (
                <div className="mt-2 rounded border border-os-border bg-os-surface px-2 py-1.5 font-mono text-[10px] leading-snug">
                  <span className={`font-bold ${result.ok ? 'text-os-ok' : 'text-os-err'}`}>
                    {result.ok ? 'OK' : 'FAIL'}
                  </span>{' '}
                  <span className="text-os-muted">{result.summary.slice(0, 240)}</span>
                </div>
              )}

              <div className="mt-3 flex items-center gap-1.5 pt-1">
                <button
                  onClick={() => run(agent)}
                  disabled={runningId === agent.id}
                  className="flex items-center gap-1 rounded border border-os-border px-2 py-1 text-[11px] text-os-muted hover:text-os-text disabled:opacity-50"
                >
                  {runningId === agent.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                  Run
                </button>
                <button
                  onClick={() => openEdit(agent)}
                  className="flex items-center gap-1 rounded border border-os-border px-2 py-1 text-[11px] text-os-muted hover:text-os-text"
                >
                  <Pencil className="h-3 w-3" /> Edit
                </button>
                <button
                  onClick={() => remove(agent)}
                  className="ml-auto flex items-center gap-1 rounded border border-os-border px-2 py-1 text-[11px] text-os-dim hover:text-os-err"
                >
                  <Trash2 className="h-3 w-3" /> Delete
                </button>
              </div>
            </article>
          );
        })}

        {agents.length === 0 && !showForm && (
          <div className="col-span-full rounded-md border border-dashed border-os-border bg-os-bg px-4 py-8 text-center">
            <p className="text-[12px] text-os-muted">No custom agents yet.</p>
            <p className="mt-1 text-[11px] text-os-dim">
              Click <span className="font-semibold text-os-text">New Agent</span> to create your first one.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
