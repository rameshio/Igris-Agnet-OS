'use client';

/**
 * Approvals inbox (Phase E). Lists every PENDING Human Approval across runs and
 * lets the operator approve/reject. The client sends ONLY the approval id, the
 * decision, and an optional note — the backend resolves the run/workflow/routes
 * from the persisted row and resumes the run. Never shows secrets (context_json
 * holds non-secret workflow data only). Polls so newly-paused runs appear.
 */
import { useCallback, useEffect, useState } from 'react';

type Approval = {
  id: string;
  runId: string;
  workflowId: string;
  nodeId: string;
  title: string;
  message: string;
  approvalRoute: string;
  rejectionRoute: string;
  requestedAt: string;
  context: unknown;
};

export function ApprovalsInbox() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/flow-approvals').catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    if (j?.approvals) setApprovals(j.approvals as Approval[]);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [load]);

  const resolve = async (id: string, decision: 'approve' | 'reject') => {
    setBusy(id);
    const res = await fetch(`/api/flow-approvals/${id}/${decision}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: notes[id]?.trim() || undefined }),
    }).catch(() => null);
    setBusy(null);
    if (res?.ok) {
      setApprovals((prev) => prev.filter((a) => a.id !== id));
      setNotes((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  if (loaded && approvals.length === 0) {
    return <p className="rounded-lg-t border border-os-border bg-os-surface px-4 py-8 text-center font-mono text-[12px] text-os-dim">No approvals waiting. Runs paused on a Human Approval node appear here.</p>;
  }

  return (
    <div className="space-y-3">
      {approvals.map((a) => (
        <div key={a.id} className="rounded-lg-t border border-os-warn/50 bg-os-surface p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.2em] text-os-warn">// awaiting approval</div>
              <h3 className="mt-0.5 truncate text-[14px] font-bold text-os-text">{a.title}</h3>
              <div className="mt-0.5 font-mono text-[9.5px] text-os-dim">
                run {a.runId.slice(0, 12)}… · node {a.nodeId} · {new Date(a.requestedAt).toLocaleString()}
              </div>
            </div>
          </div>

          {a.message && <p className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-os-muted">{a.message}</p>}

          {a.context != null && (
            <details className="mt-2">
              <summary className="cursor-pointer font-mono text-[9.5px] text-os-dim hover:text-os-muted">context</summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded border border-os-border bg-os-bg p-2 font-mono text-[9.5px] text-os-muted">{JSON.stringify(a.context, null, 2)}</pre>
            </details>
          )}

          <textarea
            value={notes[a.id] ?? ''}
            onChange={(e) => setNotes((prev) => ({ ...prev, [a.id]: e.target.value }))}
            placeholder="Resolution note (optional)"
            rows={2}
            className="mt-2 w-full resize-none rounded border border-os-border bg-os-bg px-2 py-1.5 font-mono text-[10.5px] text-os-text placeholder:text-os-dim"
          />

          <div className="mt-2 flex gap-2">
            <button
              onClick={() => resolve(a.id, 'approve')}
              disabled={busy === a.id}
              className="flex-1 rounded-md border border-os-ok/60 px-3 py-1.5 text-[12px] font-semibold text-os-ok transition-colors hover:bg-os-ok/10 disabled:opacity-50"
            >
              Approve → {a.approvalRoute}
            </button>
            <button
              onClick={() => resolve(a.id, 'reject')}
              disabled={busy === a.id}
              className="flex-1 rounded-md border border-os-err/60 px-3 py-1.5 text-[12px] font-semibold text-os-err transition-colors hover:bg-os-err/10 disabled:opacity-50"
            >
              Reject → {a.rejectionRoute}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
