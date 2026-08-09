'use client';

/**
 * Workspace danger-zone: the operator-facing trigger for the reset routines in
 * lib/reset.ts. Each destructive action is two-step (arm → confirm) so a stray
 * click can't wipe a workspace. On success the whole app is refreshed so the
 * emptied state shows everywhere at once.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Eraser, Trash2, AlertTriangle } from 'lucide-react';

type Scope = 'activity' | 'demo';

export function ResetWorkspace({ demoCleared }: { demoCleared: boolean }) {
  const router = useRouter();
  const [armed, setArmed] = useState<Scope | null>(null);
  const [busy, setBusy] = useState<Scope | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runReset = async (scope: Scope) => {
    if (armed !== scope) {
      setArmed(scope);
      setResult(null);
      setError(null);
      return;
    }
    setArmed(null);
    setBusy(scope);
    setError(null);
    setResult(null);
    const res = await fetch('/api/admin/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    setBusy(null);
    if (!res || !res.ok) {
      setError((json && json.error) || 'Reset failed.');
      return;
    }
    setResult(json.result?.summary ?? 'Done.');
    router.refresh();
  };

  const Action = ({
    scope,
    title,
    body,
    danger,
    icon: Icon,
  }: {
    scope: Scope;
    title: string;
    body: string;
    danger?: boolean;
    icon: typeof Eraser;
  }) => {
    const isArmed = armed === scope;
    const isBusy = busy === scope;
    return (
      <div className="flex items-start justify-between gap-4 rounded-md border border-os-border bg-os-bg p-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-bold">
            <Icon className="h-4 w-4 opacity-80" strokeWidth={1.8} />
            {title}
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-os-muted [text-wrap:pretty]">{body}</p>
        </div>
        <button
          onClick={() => runReset(scope)}
          onBlur={() => isArmed && setArmed(null)}
          disabled={isBusy}
          className={`shrink-0 whitespace-nowrap rounded-md border px-3 py-2 text-[12px] font-semibold transition-colors disabled:opacity-50 ${
            isArmed
              ? 'border-os-err bg-os-err text-os-bg'
              : danger
                ? 'border-os-border-bright text-os-err hover:bg-os-err hover:text-os-bg'
                : 'border-os-border-bright text-os-text hover:bg-os-text hover:text-os-bg'
          }`}
        >
          {isBusy ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…
            </span>
          ) : isArmed ? (
            'Click again to confirm'
          ) : (
            title
          )}
        </button>
      </div>
    );
  };

  return (
    <section className="rounded-lg-t border border-os-border bg-os-surface p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.26em] text-os-dim">
        <AlertTriangle className="h-3 w-3" /> // danger zone
      </div>
      <h2 className="mt-1 text-[15px] font-bold">Workspace</h2>
      <p className="mt-0.5 text-[11.5px] text-os-muted">
        {demoCleared
          ? 'This is a clean client workspace — the demo data has been cleared.'
          : 'This workspace is running the seeded demo. Clear it to hand the OS to a real client.'}
      </p>

      <div className="mt-4 space-y-2.5">
        <Action
          scope="activity"
          icon={Eraser}
          title="Clear activity logs"
          body="Wipe accumulated runs, chats, tasks, and cron history. Your data, connections, and agents are kept."
        />
        <Action
          scope="demo"
          icon={Trash2}
          danger
          title="Start clean"
          body="Remove all demo business data — the funnel, social presence, and email list — for a blank client workspace. Your custom agents and the built-in roster are kept. This cannot be undone."
        />
      </div>

      {result && (
        <p className="mt-3 rounded border border-os-border bg-os-bg px-3 py-2 font-mono text-[11px] text-os-ok">
          ✓ {result}
        </p>
      )}
      {error && (
        <p className="mt-3 rounded border border-os-border bg-os-bg px-3 py-2 font-mono text-[11px] text-os-err">
          ✗ {error}
        </p>
      )}
    </section>
  );
}
