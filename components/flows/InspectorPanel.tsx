'use client';

/**
 * Config inspector for the /flows canvas (Phase D). Lets a user configure the new
 * logic/control nodes and edge data mapping / conditions WITHOUT editing raw JSON
 * (spec §42/§43/§47). Pure presentational: it reads the selected node/edge and
 * calls back with the new config; FlowCanvas owns the graph state.
 */
import { useMemo } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { CONDITION_OPERATORS, type Condition, UNARY_OPERATORS } from '@/lib/flows/conditions';
import type { NodeType } from '@/lib/flows/schema';

export type EdgeMapping = { mode: 'all' | 'field' | 'template' | 'object'; field?: string; template?: string; object?: Record<string, string> };
export type EdgeData = { mapping?: EdgeMapping; condition?: Condition; route?: string; branchLabel?: string };

type NodeLite = { id: string; label?: string; nodeType: NodeType };

const lbl = 'text-[9px] uppercase tracking-[0.18em] text-os-dim';
const field = 'w-full rounded border border-os-border bg-os-bg px-2 py-1 text-[11px] text-os-text placeholder:text-os-dim focus:border-os-border-bright focus:outline-none';
const mini = 'rounded border border-os-border bg-os-bg px-1.5 py-1 text-[10.5px] text-os-text focus:border-os-border-bright focus:outline-none';

function ConditionEditor({ value, onChange }: { value: Condition; onChange: (c: Condition) => void }) {
  const unary = UNARY_OPERATORS.has(value.operator);
  return (
    <div className="space-y-1">
      <input className={field} placeholder="{{Node.data.field}}" value={value.left} onChange={(e) => onChange({ ...value, left: e.target.value })} />
      <div className="flex gap-1">
        <select className={`${mini} flex-1`} value={value.operator} onChange={(e) => onChange({ ...value, operator: e.target.value as Condition['operator'] })}>
          {CONDITION_OPERATORS.map((op) => (
            <option key={op} value={op}>{op}</option>
          ))}
        </select>
        {!unary && (
          <input
            className={`${mini} flex-1`}
            placeholder="value or {{ref}}"
            value={value.right == null ? '' : String(value.right)}
            onChange={(e) => {
              const raw = e.target.value;
              const num = Number(raw);
              const next = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && Number.isFinite(num) && !raw.includes('{{') ? num : raw;
              onChange({ ...value, right: next });
            }}
          />
        )}
      </div>
    </div>
  );
}

function KeyValueRows({ obj, onChange }: { obj: Record<string, string>; onChange: (o: Record<string, string>) => void }) {
  const entries = Object.entries(obj);
  return (
    <div className="space-y-1">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            className={`${mini} w-24`}
            placeholder="key"
            value={k}
            onChange={(e) => {
              const next: Record<string, string> = {};
              entries.forEach(([kk, vv], j) => (next[j === i ? e.target.value : kk] = vv));
              onChange(next);
            }}
          />
          <input
            className={`${mini} min-w-0 flex-1`}
            placeholder="{{Node.data.field}}"
            value={v}
            onChange={(e) => {
              const next: Record<string, string> = {};
              entries.forEach(([kk, vv], j) => (next[kk] = j === i ? e.target.value : vv));
              onChange(next);
            }}
          />
          <button className="text-os-dim hover:text-os-err" onClick={() => onChange(Object.fromEntries(entries.filter((_, j) => j !== i)))} aria-label="Remove field">
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
      <button className="flex items-center gap-1 text-[10px] text-os-muted hover:text-os-text" onClick={() => onChange({ ...obj, [`field${entries.length + 1}`]: '' })}>
        <Plus className="h-3 w-3" /> add field
      </button>
    </div>
  );
}

export function NodeInspector({
  nodeId,
  nodeType,
  label,
  description,
  config,
  onConfig,
  onLabel,
  onDescription,
  onDelete,
  onClose,
}: {
  nodeId: string;
  nodeType: NodeType;
  label?: string;
  description?: string;
  config: Record<string, unknown>;
  onConfig: (config: Record<string, unknown>) => void;
  onLabel: (label: string) => void;
  onDescription: (description: string) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const set = (patch: Record<string, unknown>) => onConfig({ ...config, ...patch });
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold text-os-text">{nodeType} node</div>
        <button onClick={onClose} className="text-os-dim hover:text-os-text" aria-label="Close inspector"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div>
        <div className={lbl}>label / name</div>
        <input className={field} value={label ?? ''} placeholder={nodeType} onChange={(e) => onLabel(e.target.value)} />
      </div>
      <div>
        <div className={lbl}>description (optional)</div>
        <textarea rows={2} className={field} placeholder="What this node is for…" value={description ?? ''} onChange={(e) => onDescription(e.target.value)} />
      </div>
      <div className="font-mono text-[9px] text-os-dim">id {nodeId}</div>

      {nodeType === 'input' && (
        <>
          <div>
            <div className={lbl}>default value</div>
            <textarea rows={2} className={field} value={String(config.value ?? '')} onChange={(e) => set({ value: e.target.value })} />
            <p className="mt-0.5 font-mono text-[8.5px] text-os-dim">Fallback only — used when the run&apos;s <b>Starting Input</b> is empty. The Starting Input box is the runtime value.</p>
          </div>
          <div><div className={lbl}>format</div>
            <select className={`${mini} w-full`} value={String(config.format ?? 'text')} onChange={(e) => set({ format: e.target.value })}>
              {['text', 'json', 'url', 'file'].map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </>
      )}

      {nodeType === 'output' && (
        <div><div className={lbl}>mode</div>
          <select className={`${mini} w-full`} value={String(config.mode ?? 'display')} onChange={(e) => set({ mode: e.target.value })}>
            {['display', 'save', 'draft', 'notify'].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      )}

      {nodeType === 'transform' && (
        <TransformInspector config={config} set={set} />
      )}

      {nodeType === 'decision' && (
        <DecisionInspector config={config} set={set} />
      )}

      {nodeType === 'approval' && (
        <ApprovalInspector config={config} set={set} />
      )}

      {nodeType === 'join' && <p className="font-mono text-[10px] text-os-muted">Mode: wait for all active branches.</p>}
      {nodeType === 'parallel' && <p className="font-mono text-[10px] text-os-muted">Fans out into independent branches (one per outgoing edge).</p>}
      {nodeType === 'agent' && <p className="font-mono text-[10px] text-os-muted">Model & instructions come from the agent (edit on /agents).</p>}

      {onDelete && (
        <div className="border-t border-os-border pt-2">
          <button
            onClick={onDelete}
            className="flex w-full items-center justify-center gap-1.5 rounded border border-os-err/60 px-2 py-1.5 text-[11px] font-semibold text-os-err hover:bg-os-err/10"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete node
          </button>
          <p className="mt-1 font-mono text-[8.5px] text-os-dim">Removes this node and its connected edges from the draft. Save to persist.</p>
        </div>
      )}
    </div>
  );
}

function TransformInspector({ config, set }: { config: Record<string, unknown>; set: (p: Record<string, unknown>) => void }) {
  const mode = String(config.mode ?? 'object') as 'object' | 'template' | 'field';
  return (
    <>
      <div><div className={lbl}>mode</div>
        <select className={`${mini} w-full`} value={mode} onChange={(e) => set({ mode: e.target.value })}>
          {['object', 'template', 'field'].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      {mode === 'object' && (
        <div><div className={lbl}>object fields</div><KeyValueRows obj={(config.object as Record<string, string>) ?? {}} onChange={(o) => set({ object: o })} /></div>
      )}
      {mode === 'template' && (
        <div><div className={lbl}>template</div><textarea rows={3} className={field} placeholder="{{Analyzer.data.company}} — Fit {{Analyzer.data.score}}" value={String(config.template ?? '')} onChange={(e) => set({ template: e.target.value })} /></div>
      )}
      {mode === 'field' && (
        <div><div className={lbl}>field reference</div><input className={field} placeholder="{{Analyzer.data.skills}}" value={String(config.field ?? '')} onChange={(e) => set({ field: e.target.value })} /></div>
      )}
    </>
  );
}

function ApprovalInspector({ config, set }: { config: Record<string, unknown>; set: (p: Record<string, unknown>) => void }) {
  // A HUMAN gate — kept separate from the machine-logic Decision node. `message`
  // may use {{Node.field}} references (same resolver). approve/reject route labels
  // are the source-handle names you assign to the two outgoing edges.
  return (
    <>
      <div><div className={lbl}>title</div><input className={field} placeholder="Human approval required" value={String(config.title ?? '')} onChange={(e) => set({ title: e.target.value })} /></div>
      <div><div className={lbl}>message (supports {'{{Node.field}}'})</div><textarea rows={3} className={field} placeholder="Approve sending this email? {{Draft.text}}" value={String(config.message ?? '')} onChange={(e) => set({ message: e.target.value })} /></div>
      <div className="flex gap-1.5">
        <div className="flex-1"><div className={lbl}>approve route</div><input className={field} placeholder="approve" value={String(config.approveRoute ?? '')} onChange={(e) => set({ approveRoute: e.target.value })} /></div>
        <div className="flex-1"><div className={lbl}>reject route</div><input className={field} placeholder="reject" value={String(config.rejectRoute ?? '')} onChange={(e) => set({ rejectRoute: e.target.value })} /></div>
      </div>
      <p className="font-mono text-[8.5px] text-os-dim">Assign these route labels to the two outgoing edges — approve activates only the approve edge, reject only the reject edge.</p>
    </>
  );
}

function DecisionInspector({ config, set }: { config: Record<string, unknown>; set: (p: Record<string, unknown>) => void }) {
  const rules = (config.rules as { route: string; condition: Condition }[]) ?? [];
  const setRule = (i: number, patch: Partial<{ route: string; condition: Condition }>) =>
    set({ rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <>
      <div className={lbl}>rules (first match wins)</div>
      <div className="space-y-2">
        {rules.map((r, i) => (
          <div key={i} className="rounded border border-os-border bg-os-bg p-1.5">
            <div className="mb-1 flex items-center gap-1">
              <span className="text-[9px] text-os-dim">IF</span>
              <span className="ml-auto text-[9px] text-os-dim">THEN route</span>
              <input className={`${mini} w-20`} placeholder="route" value={r.route} onChange={(e) => setRule(i, { route: e.target.value })} />
              <button className="text-os-dim hover:text-os-err" onClick={() => set({ rules: rules.filter((_, j) => j !== i) })} aria-label="Remove rule"><Trash2 className="h-3 w-3" /></button>
            </div>
            <ConditionEditor value={r.condition} onChange={(c) => setRule(i, { condition: c })} />
          </div>
        ))}
        <button
          className="flex items-center gap-1 text-[10px] text-os-muted hover:text-os-text"
          onClick={() => set({ rules: [...rules, { route: `route${rules.length + 1}`, condition: { left: '', operator: 'equals', right: '' } as Condition }] })}
        >
          <Plus className="h-3 w-3" /> add rule
        </button>
      </div>
      <div><div className={lbl}>default route (optional)</div><input className={field} placeholder="e.g. low" value={String(config.defaultRoute ?? '')} onChange={(e) => set({ defaultRoute: e.target.value || undefined })} /></div>
    </>
  );
}

export function EdgeInspector({
  edgeId,
  data,
  sourceType,
  decisionRoutes,
  onData,
  onClose,
}: {
  edgeId: string;
  data: EdgeData;
  sourceType?: NodeType;
  decisionRoutes: string[];
  onData: (d: EdgeData) => void;
  onClose: () => void;
}) {
  const mapping = data.mapping ?? { mode: 'all' };
  const condOn = !!data.condition;
  const setMapping = (m: EdgeMapping) => onData({ ...data, mapping: m });
  const routes = useMemo(() => decisionRoutes, [decisionRoutes]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold text-os-text">edge</div>
        <button onClick={onClose} className="text-os-dim hover:text-os-text" aria-label="Close inspector"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="font-mono text-[9px] text-os-dim">id {edgeId}</div>

      {(sourceType === 'decision' || sourceType === 'approval') && (
        <div><div className={lbl}>route (from {sourceType})</div>
          <select className={`${mini} w-full`} value={data.route ?? ''} onChange={(e) => onData({ ...data, route: e.target.value || undefined })}>
            <option value="">— pick route —</option>
            {routes.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      )}

      <div><div className={lbl}>data mapping</div>
        <div className="flex flex-wrap gap-1">
          {(['all', 'field', 'template', 'object'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMapping({ ...mapping, mode: m })}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${mapping.mode === m ? 'border-os-border-bright bg-os-text text-os-bg' : 'border-os-border text-os-muted hover:text-os-text'}`}
            >
              {m === 'all' ? 'entire output' : m}
            </button>
          ))}
        </div>
      </div>
      {mapping.mode === 'field' && <input className={field} placeholder="{{Node.data.field}}" value={mapping.field ?? ''} onChange={(e) => setMapping({ ...mapping, field: e.target.value })} />}
      {mapping.mode === 'template' && <textarea rows={2} className={field} placeholder="Score: {{Node.data.score}}" value={mapping.template ?? ''} onChange={(e) => setMapping({ ...mapping, template: e.target.value })} />}
      {mapping.mode === 'object' && <KeyValueRows obj={mapping.object ?? {}} onChange={(o) => setMapping({ ...mapping, object: o })} />}

      <div className="border-t border-os-border pt-2">
        <label className="flex items-center gap-1.5 text-[10px] text-os-muted">
          <input
            type="checkbox"
            checked={condOn}
            onChange={(e) => onData({ ...data, condition: e.target.checked ? { left: '', operator: 'exists' } : undefined })}
          />
          conditional edge
        </label>
        {condOn && data.condition && <div className="mt-1"><ConditionEditor value={data.condition} onChange={(c) => onData({ ...data, condition: c })} /></div>}
      </div>
      <p className="font-mono text-[8.5px] text-os-dim">Example: field <code>{'{{Analyzer.data.skills}}'}</code> · condition <code>{'{{Agent.data.confidence}}'}</code> ≥ 0.8</p>
    </div>
  );
}
