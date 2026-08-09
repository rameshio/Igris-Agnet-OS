'use client';

/**
 * The workflow builder: create your own workflows and connect tools to each
 * step. Posts to /api/workflows; each saved workflow gets Edit / Delete. Tools
 * come from the integration catalog so a step wires to real connectors.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, Pencil, X, Loader2, GripVertical } from 'lucide-react';
import type { Workflow } from '@/lib/schemas';

type ToolOption = { slug: string; name: string; category: string };
type StepDraft = { title: string; owner: string; ownerKind: 'human' | 'agent'; tools: string[] };

const emptyStep = (): StepDraft => ({ title: '', owner: '', ownerKind: 'agent', tools: [] });

const inputClass =
  'min-w-0 flex-1 rounded border border-os-border bg-os-bg px-2 py-1.5 text-[12px] text-os-text placeholder:text-os-dim focus:border-os-border-bright focus:outline-none';

function ToolPicker({
  tools,
  selected,
  onToggle,
}: {
  tools: ToolOption[];
  selected: string[];
  onToggle: (slug: string) => void;
}) {
  const [query, setQuery] = useState('');
  const nameBySlug = useMemo(() => new Map(tools.map((t) => [t.slug, t.name])), [tools]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return tools.filter((t) => t.name.toLowerCase().includes(q) || t.slug.includes(q)).slice(0, 8);
  }, [tools, query]);

  return (
    <div>
      <div className="mb-1 flex flex-wrap gap-1">
        {selected.map((slug) => (
          <span
            key={slug}
            className="flex items-center gap-1 rounded border border-os-border-bright bg-os-surface2 px-1.5 py-0.5 font-mono text-[10px] text-os-text"
          >
            {nameBySlug.get(slug) ?? slug}
            <button onClick={() => onToggle(slug)} className="text-os-dim hover:text-os-err" aria-label={`Remove ${slug}`}>
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        {selected.length === 0 && <span className="font-mono text-[10px] text-os-dim">no tools connected</span>}
      </div>
      <div className="relative">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Connect a tool… (Slack, Stripe, Notion, GitHub…)"
          className={`${inputClass} text-[11px]`}
        />
        {matches.length > 0 && (
          <div className="absolute z-10 mt-1 w-full overflow-hidden rounded border border-os-border bg-os-bg shadow-lg">
            {matches.map((t) => {
              const on = selected.includes(t.slug);
              return (
                <button
                  key={t.slug}
                  onClick={() => {
                    onToggle(t.slug);
                    setQuery('');
                  }}
                  className="flex w-full items-center justify-between px-2 py-1.5 text-left text-[11px] hover:bg-os-surface2"
                >
                  <span className="text-os-text">{t.name}</span>
                  <span className="font-mono text-[9px] text-os-dim">{on ? '✓ connected' : t.category}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkflowBuilder({
  tools,
  initialWorkflows,
}: {
  tools: ToolOption[];
  initialWorkflows: Workflow[];
}) {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<Workflow[]>(initialWorkflows);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [steps, setSteps] = useState<StepDraft[]>([emptyStep()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName('');
    setSubtitle('');
    setSteps([emptyStep()]);
    setEditingId(null);
    setError(null);
  };

  const openCreate = () => {
    reset();
    setShowForm(true);
  };

  const openEdit = (wf: Workflow) => {
    setEditingId(wf.id);
    setName(wf.name);
    setSubtitle(wf.subtitle);
    setSteps(
      wf.steps.length
        ? wf.steps.map((s) => ({ title: s.title, owner: s.owner, ownerKind: s.ownerKind, tools: s.tools }))
        : [emptyStep()],
    );
    setError(null);
    setShowForm(true);
  };

  const setStep = (i: number, patch: Partial<StepDraft>) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const addStep = () => setSteps((prev) => [...prev, emptyStep()]);
  const removeStep = (i: number) => setSteps((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));
  const toggleTool = (i: number, slug: string) =>
    setStep(i, {
      tools: steps[i].tools.includes(slug) ? steps[i].tools.filter((s) => s !== slug) : [...steps[i].tools, slug],
    });

  const submit = async () => {
    const cleanSteps = steps
      .map((s) => ({ ...s, title: s.title.trim(), owner: s.owner.trim() || 'Unassigned' }))
      .filter((s) => s.title);
    if (!name.trim()) return setError('Give the workflow a name.');
    if (cleanSteps.length === 0) return setError('Add at least one step with a title.');

    setBusy(true);
    setError(null);
    const editing = editingId !== null;
    const res = await fetch(editing ? `/api/workflows/${editingId}` : '/api/workflows', {
      method: editing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), subtitle: subtitle.trim(), steps: cleanSteps }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    setBusy(false);
    if (!res || !res.ok) return setError((json && json.error) || 'Save failed.');

    const saved: Workflow = json.workflow;
    setWorkflows((prev) => (editing ? prev.map((w) => (w.id === saved.id ? saved : w)) : [...prev, saved]));
    setShowForm(false);
    reset();
    router.refresh();
  };

  const remove = async (wf: Workflow) => {
    const res = await fetch(`/api/workflows/${wf.id}`, { method: 'DELETE' }).catch(() => null);
    if (res?.ok) {
      setWorkflows((prev) => prev.filter((w) => w.id !== wf.id));
      router.refresh();
    }
  };

  return (
    <section className="mb-8 rounded-lg-t border border-os-border bg-os-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.26em] text-os-dim">// build</div>
          <h2 className="mt-1 text-[15px] font-bold">Your Workflows</h2>
          <p className="mt-0.5 text-[11.5px] text-os-muted">
            Design a process step by step and connect the tools each step uses.
          </p>
        </div>
        {!showForm && (
          <button
            onClick={openCreate}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-os-border-bright bg-os-text px-3 py-2 text-[12px] font-semibold text-os-bg hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" /> New Workflow
          </button>
        )}
      </div>

      {showForm && (
        <div className="mt-4 rounded-md border border-os-border bg-os-bg p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-[0.2em] text-os-dim">
              {editingId ? 'Edit workflow' : 'New workflow'}
            </div>
            <button onClick={() => { setShowForm(false); reset(); }} className="text-os-dim hover:text-os-text" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Workflow name (e.g. Client onboarding)" className={inputClass} />
            <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="Subtitle (optional)" className={inputClass} />
          </div>

          <div className="mt-3 space-y-2.5">
            <div className="text-[10px] uppercase tracking-[0.2em] text-os-dim">Steps</div>
            {steps.map((step, i) => (
              <div key={i} className="rounded border border-os-border bg-os-surface p-2.5">
                <div className="flex items-center gap-2">
                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-os-dim" />
                  <span className="shrink-0 font-mono text-[10px] text-os-dim">{i + 1}</span>
                  <input
                    value={step.title}
                    onChange={(e) => setStep(i, { title: e.target.value })}
                    placeholder="Step title (e.g. Qualify the lead)"
                    className={inputClass}
                  />
                  <select
                    value={step.ownerKind}
                    onChange={(e) => setStep(i, { ownerKind: e.target.value as 'human' | 'agent' })}
                    className="shrink-0 rounded border border-os-border bg-os-bg px-1.5 py-1.5 text-[11px] text-os-text focus:outline-none"
                  >
                    <option value="agent">Agent</option>
                    <option value="human">Human</option>
                  </select>
                  <button
                    onClick={() => removeStep(i)}
                    disabled={steps.length === 1}
                    className="shrink-0 text-os-dim hover:text-os-err disabled:opacity-30"
                    aria-label="Remove step"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2 pl-8">
                  <input
                    value={step.owner}
                    onChange={(e) => setStep(i, { owner: e.target.value })}
                    placeholder={step.ownerKind === 'agent' ? 'Owner agent (e.g. Sales Agent)' : 'Owner (e.g. You)'}
                    className={`${inputClass} max-w-[240px]`}
                  />
                </div>
                <div className="mt-2 pl-8">
                  <ToolPicker tools={tools} selected={step.tools} onToggle={(slug) => toggleTool(i, slug)} />
                </div>
              </div>
            ))}
            <button
              onClick={addStep}
              className="flex items-center gap-1.5 rounded border border-dashed border-os-border px-2.5 py-1.5 text-[11px] text-os-muted hover:text-os-text"
            >
              <Plus className="h-3 w-3" /> Add step
            </button>
          </div>

          {error && <p className="mt-3 font-mono text-[10.5px] text-os-err">✗ {error}</p>}

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={submit}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md border border-os-border-bright bg-os-text px-3 py-1.5 text-[12px] font-semibold text-os-bg hover:opacity-90 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {editingId ? 'Save changes' : 'Create workflow'}
            </button>
            <button onClick={() => { setShowForm(false); reset(); }} className="rounded-md border border-os-border px-3 py-1.5 text-[12px] text-os-muted hover:text-os-text">
              Cancel
            </button>
          </div>
        </div>
      )}

      {workflows.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {workflows.map((wf) => (
            <article key={wf.id} className="flex flex-col rounded-md border border-os-border bg-os-bg p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-[13px] font-bold">{wf.name}</h3>
                  {wf.subtitle && <div className="mt-0.5 truncate text-[11px] text-os-muted">{wf.subtitle}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button onClick={() => openEdit(wf)} className="rounded border border-os-border px-1.5 py-1 text-os-muted hover:text-os-text" aria-label="Edit">
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button onClick={() => remove(wf)} className="rounded border border-os-border px-1.5 py-1 text-os-dim hover:text-os-err" aria-label="Delete">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="mt-2 font-mono text-[10px] text-os-dim">
                {wf.steps.length} step{wf.steps.length === 1 ? '' : 's'} ·{' '}
                {new Set(wf.steps.flatMap((s) => s.tools)).size} tool{new Set(wf.steps.flatMap((s) => s.tools)).size === 1 ? '' : 's'}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
