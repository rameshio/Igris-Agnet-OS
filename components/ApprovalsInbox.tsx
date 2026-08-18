'use client';

/**
 * Approval Decision Cards (UX Foundation U5, Part A). A trustworthy decision
 * surface over Phase-E Human Approvals: each pending card answers WHAT is
 * requesting permission, WHY, what approve/reject each do, WHERE it came from,
 * and the (conservative) RISK — reading the read-only projection
 * GET /api/flow-approvals/cards (never raw context_json).
 *
 * Safety (unchanged from Phase E): the client sends ONLY the approval id + the
 * decision + an optional note to POST /api/flow-approvals/:id/approve|reject; the
 * backend resolves the run/workflow/routes from the persisted row and resumes the
 * run. No new approval mechanism, no auto-approval. Selecting a card publishes
 * identifiers into the U1 Context Envelope so the existing Commander "approve this"
 * (U3) can act on it. Resolved cards are inspectable but their actions are disabled.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ApprovalDecisionView, ApprovalRisk } from '@/lib/flows/approval-view';
import type { ApprovalRequestType } from '@/lib/flows/run-types';
import { clearApprovalContext, publishApprovalContext } from '@/lib/context-envelope';
import { Badge } from '@/components/terminal';

type Cards = { pending: ApprovalDecisionView[]; resolved: ApprovalDecisionView[] };

const WHY: Record<ApprovalRequestType, string> = {
  workflow: 'Workflow reached a Human Approval gate',
  hermes: 'A Hermes action requires human approval',
  tool: 'A tool action requires human approval',
  sudo: 'A privileged (sudo) action requires human approval',
  secret: 'Access to a secret requires human approval',
};

const RISK_TONE: Record<ApprovalRisk, 'ok' | 'warn' | 'err'> = { low: 'ok', medium: 'warn', high: 'err' };
const RISK_WORD: Record<ApprovalRisk, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const STATUS_TONE: Record<string, 'ok' | 'warn' | 'err' | 'default'> = {
  approved: 'ok',
  rejected: 'err',
  expired: 'default',
  cancelled: 'default',
};

function runShort(runId: string): string {
  return runId.length > 14 ? `${runId.slice(0, 14)}…` : runId;
}

/** A labelled block: WHAT / WHY / IF APPROVED / IF REJECTED / RISK. */
function Field({ label, children, tone }: { label: string; children: React.ReactNode; tone?: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-os-dim">{label}</div>
      <div className={`mt-0.5 text-[11.5px] leading-snug ${tone ?? 'text-os-muted'}`}>{children}</div>
    </div>
  );
}

function CardHead({ card }: { card: ApprovalDecisionView }) {
  return (
    <div className="min-w-0">
      <h3 className="truncate text-[14px] font-bold text-os-text">{card.title}</h3>
      <div className="mt-0.5 font-mono text-[9.5px] text-os-dim">
        Workflow: {card.workflowName ?? card.workflowId}
        {' · '}Run: {runShort(card.runId)}
        {' · '}node {card.nodeId}
      </div>
    </div>
  );
}

export function ApprovalsInbox() {
  const [cards, setCards] = useState<Cards>({ pending: [], resolved: [] });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/flow-approvals/cards').catch(() => null);
    const j = res ? ((await res.json().catch(() => null)) as Cards | null) : null;
    if (j?.pending) setCards({ pending: j.pending, resolved: j.resolved ?? [] });
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [load]);

  // Publishing selection is an EVENT effect — never a side effect inside a state
  // updater (the U3 incident). Clear on unmount so stale ids never linger.
  useEffect(() => () => clearApprovalContext(), []);

  const select = (card: ApprovalDecisionView) => {
    setSelectedId(card.approvalId);
    publishApprovalContext({ approvalId: card.approvalId, runId: card.runId, workflowId: card.workflowId });
  };

  const resolve = async (card: ApprovalDecisionView, decision: 'approve' | 'reject') => {
    setBusy(card.approvalId);
    const res = await fetch(`/api/flow-approvals/${card.approvalId}/${decision}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: notes[card.approvalId]?.trim() || undefined }),
    }).catch(() => null);
    setBusy(null);
    if (res?.ok) {
      setNotes((prev) => {
        const next = { ...prev };
        delete next[card.approvalId];
        return next;
      });
      if (selectedId === card.approvalId) {
        setSelectedId(null);
        clearApprovalContext();
      }
      void load(); // refresh: it moves from pending → resolved
    }
  };

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-os-dim">
          Pending {cards.pending.length > 0 && <span className="text-os-warn">· {cards.pending.length}</span>}
        </div>

        {loaded && cards.pending.length === 0 ? (
          <p className="rounded-lg-t border border-os-border bg-os-surface px-4 py-8 text-center font-mono text-[12px] text-os-dim">
            No approvals waiting. Runs paused on a Human Approval node appear here.
          </p>
        ) : (
          <div className="space-y-3">
            {cards.pending.map((card) => {
              const selected = selectedId === card.approvalId;
              return (
                <div
                  key={card.approvalId}
                  onClick={() => select(card)}
                  className={`cursor-pointer rounded-lg-t border bg-os-surface p-4 transition-colors ${
                    selected ? 'border-os-warn ring-1 ring-os-warn/40' : 'border-os-warn/50 hover:border-os-warn/80'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-os-warn">⏸ approval</div>
                      <div className="mt-0.5">
                        <CardHead card={card} />
                      </div>
                    </div>
                    <Badge tone={RISK_TONE[card.risk]}>
                      Risk {RISK_WORD[card.risk]}
                    </Badge>
                  </div>

                  <div className="mt-3 grid gap-2.5">
                    <Field label="What" tone="text-os-text">
                      {card.message ?? 'Awaiting your decision on this step.'}
                    </Field>
                    <Field label="Why">{WHY[card.requestType]}</Field>
                    <div className="grid grid-cols-2 gap-2.5">
                      <Field label="If approved" tone="text-os-ok">{card.approveEffect}</Field>
                      <Field label="If rejected" tone="text-os-err">{card.rejectEffect}</Field>
                    </div>
                    <Field label="Risk" tone={`text-os-${RISK_TONE[card.risk]}`}>
                      {RISK_WORD[card.risk]} · {card.riskReason}
                    </Field>
                  </div>

                  {/* Stop card-select from firing when interacting with the controls. */}
                  <div onClick={(e) => e.stopPropagation()}>
                    <textarea
                      value={notes[card.approvalId] ?? ''}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [card.approvalId]: e.target.value }))}
                      placeholder="Resolution note (optional)"
                      rows={2}
                      className="mt-3 w-full resize-none rounded border border-os-border bg-os-bg px-2 py-1.5 font-mono text-[10.5px] text-os-text placeholder:text-os-dim"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => resolve(card, 'approve')}
                        disabled={busy === card.approvalId}
                        className="flex-1 rounded-md border border-os-ok/60 px-3 py-1.5 text-[12px] font-semibold text-os-ok transition-colors hover:bg-os-ok/10 disabled:opacity-50"
                      >
                        Approve → {card.approveRoute}
                      </button>
                      <button
                        onClick={() => resolve(card, 'reject')}
                        disabled={busy === card.approvalId}
                        className="flex-1 rounded-md border border-os-err/60 px-3 py-1.5 text-[12px] font-semibold text-os-err transition-colors hover:bg-os-err/10 disabled:opacity-50"
                      >
                        Reject → {card.rejectRoute}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {cards.resolved.length > 0 && (
        <section>
          <div className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-os-dim">
            Resolved · {cards.resolved.length}
          </div>
          <div className="space-y-2">
            {cards.resolved.map((card) => (
              <div key={card.approvalId} className="rounded-lg-t border border-os-border bg-os-surface/60 p-3 opacity-90">
                <div className="flex items-start justify-between gap-3">
                  <CardHead card={card} />
                  <Badge tone={STATUS_TONE[card.status] ?? 'default'}>{card.status}</Badge>
                </div>
                <div className="mt-1.5 font-mono text-[9.5px] text-os-dim">
                  Risk {RISK_WORD[card.risk]} · {card.riskReason}
                  {card.resolvedBy && <> · by {card.resolvedBy}</>}
                </div>
                {card.resolutionNote && (
                  <p className="mt-1 whitespace-pre-wrap font-mono text-[10px] text-os-muted">“{card.resolutionNote}”</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
