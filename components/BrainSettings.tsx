'use client';

/**
 * Choose the agents' brain: the cloud AI Gateway or a local Hermes CLI running
 * on this machine. Saving writes to .env.local (immediate). "Test brain" runs a
 * real prompt through the selected provider so you get honest proof it works.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Cloud, Cpu, Loader2, Check, X } from 'lucide-react';

type Provider = 'gateway' | 'hermes';

export function BrainSettings({
  initialProvider,
  initialHermesBin,
}: {
  initialProvider: string;
  initialHermesBin: string;
}) {
  const router = useRouter();
  const [provider, setProvider] = useState<Provider>(initialProvider === 'hermes' ? 'hermes' : 'gateway');
  const [hermesBin, setHermesBin] = useState(initialHermesBin || 'hermes');
  const [savingBusy, setSavingBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; provider?: string; text?: string; error?: string } | null>(null);

  const save = async () => {
    setSavingBusy(true);
    setSaved(false);
    const res = await fetch('/api/settings/brain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, hermesBin: hermesBin.trim() }),
    }).catch(() => null);
    setSavingBusy(false);
    if (res?.ok) {
      setSaved(true);
      router.refresh();
    }
  };

  const runTest = async () => {
    setTestBusy(true);
    setTest(null);
    const res = await fetch('/api/settings/brain/test', { method: 'POST' }).catch(() => null);
    const json = res ? await res.json().catch(() => ({ ok: false, error: 'request failed' })) : { ok: false, error: 'request failed' };
    setTestBusy(false);
    setTest(json);
  };

  const Card = ({ id, icon: Icon, title, body }: { id: Provider; icon: typeof Cloud; title: string; body: string }) => {
    const active = provider === id;
    return (
      <button
        onClick={() => { setProvider(id); setSaved(false); }}
        className={`flex-1 rounded-md border p-3 text-left transition-colors ${
          active ? 'border-os-border-bright bg-os-surface2' : 'border-os-border bg-os-bg hover:border-os-border-strong'
        }`}
      >
        <div className="flex items-center gap-2 text-[13px] font-bold">
          <Icon className="h-4 w-4" strokeWidth={1.8} />
          {title}
          {active && <Check className="ml-auto h-3.5 w-3.5 text-os-ok" />}
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-os-muted">{body}</p>
      </button>
    );
  };

  return (
    <section className="mb-6 rounded-lg-t border border-os-border bg-os-surface p-4">
      <div className="text-[10px] uppercase tracking-[0.26em] text-os-dim">// agent brain</div>
      <h2 className="mt-1 text-[15px] font-bold">Brain</h2>
      <p className="mt-0.5 text-[11.5px] text-os-muted">
        What powers agent thinking. Every agent run and chat goes through this.
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Card
          id="gateway"
          icon={Cloud}
          title="Cloud — AI Gateway"
          body="Agents think via the Vercel AI Gateway (needs AI_GATEWAY_API_KEY). Supports tool-calling."
        />
        <Card
          id="hermes"
          icon={Cpu}
          title="Local — Hermes CLI"
          body="Agents think via your Hermes install on this machine (hermes chat -q … --quiet). Private, no cloud key."
        />
      </div>

      {provider === 'hermes' && (
        <div className="mt-3">
          <label className="mb-1 block text-[10px] uppercase tracking-[0.2em] text-os-dim">Hermes command / path</label>
          <input
            value={hermesBin}
            onChange={(e) => { setHermesBin(e.target.value); setSaved(false); }}
            placeholder="hermes"
            className="w-full rounded border border-os-border bg-os-bg px-2 py-1.5 font-mono text-[11px] text-os-text placeholder:text-os-dim focus:border-os-border-bright focus:outline-none"
          />
          <p className="mt-1 text-[9.5px] text-os-dim">
            Just <code>hermes</code> if it's on PATH, or the full path (e.g. C:\…\Scripts\hermes.exe).
          </p>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={save}
          disabled={savingBusy}
          className="flex items-center gap-1.5 rounded-md border border-os-border-bright bg-os-text px-3 py-1.5 text-[12px] font-semibold text-os-bg hover:opacity-90 disabled:opacity-50"
        >
          {savingBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save brain
        </button>
        <button
          onClick={runTest}
          disabled={testBusy}
          className="flex items-center gap-1.5 rounded-md border border-os-border px-3 py-1.5 text-[12px] text-os-muted hover:text-os-text disabled:opacity-50"
        >
          {testBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cpu className="h-3.5 w-3.5" />}
          Test brain
        </button>
        {saved && <span className="font-mono text-[10px] text-os-ok">✓ saved</span>}
      </div>

      {test && (
        <div className={`mt-3 rounded border px-3 py-2 font-mono text-[10.5px] leading-snug ${test.ok ? 'border-os-border text-os-ok' : 'border-os-border text-os-err'}`}>
          <span className="flex items-center gap-1.5 font-bold">
            {test.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            {test.ok ? 'Brain responded' : 'Brain error'} · {test.provider ?? provider}
          </span>
          <span className="mt-1 block whitespace-pre-wrap break-words text-os-muted">{test.ok ? test.text : test.error}</span>
        </div>
      )}
    </section>
  );
}
