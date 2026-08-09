'use client';

/**
 * Models board (Phase B). Two concerns, kept separate:
 *   A. Provider connections — cloud + local model providers (API key / base URL).
 *   B. Brains — Hermes (ACP), shown honestly, NOT as an API-key provider card.
 * Keys are written to .env.local by the API and never returned here; this UI
 * only ever learns `hasCredential`.
 */
import { useEffect, useState } from 'react';
import { Check, Loader2, Plug, X, Copy, RefreshCw, ExternalLink, Power, Cpu } from 'lucide-react';

type Provider = {
  id: string;
  name: string;
  docsUrl: string;
  requiresKey: boolean;
  local: boolean;
  allowBaseUrl: boolean;
  baseUrl: string;
  hasCredential: boolean;
  enabled: boolean;
  status: 'not_configured' | 'configured' | 'connected' | 'error' | 'disabled';
  connected: boolean;
  models: string[];
  lastCheckAt: string | null;
  lastError: string | null;
};
type Brain = { id: string; name: string; transport: string; activeProvider: string; isActive: boolean; status: string };

const STATUS_DOT: Record<Provider['status'], string> = {
  connected: 'bg-os-ok',
  configured: 'bg-os-warn',
  error: 'bg-os-err',
  disabled: 'bg-os-dim',
  not_configured: 'bg-os-dim',
};

export function ModelsBoard() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [brain, setBrain] = useState<Brain | null>(null);
  const [keyInput, setKeyInput] = useState<Record<string, string>>({});
  const [urlInput, setUrlInput] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch('/api/models').catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    if (j?.providers) setProviders(j.providers);
    if (j?.brain) setBrain(j.brain);
  };
  useEffect(() => {
    void load();
  }, []);

  const post = async (providerId: string, extra: Record<string, unknown>) => {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, ...extra }),
    }).catch(() => null);
    return res ? await res.json().catch(() => null) : null;
  };

  const connect = async (p: Provider) => {
    setBusy(p.id);
    const j = await post(p.id, { action: 'connect', apiKey: (keyInput[p.id] ?? '').trim() || undefined, baseUrl: (urlInput[p.id] ?? '').trim() || undefined });
    setBusy(null);
    setKeyInput((k) => ({ ...k, [p.id]: '' }));
    setNote((n) => ({ ...n, [p.id]: j?.ok ? 'Saved ✓' : j?.error ?? 'connect failed' }));
    void load();
  };
  const test = async (p: Provider) => {
    setBusy(p.id);
    setNote((n) => ({ ...n, [p.id]: 'Testing…' }));
    const j = await post(p.id, { action: 'test' });
    setBusy(null);
    setNote((n) => ({ ...n, [p.id]: j?.ok ? `✓ Connected — ${j.count} models` : j?.error ?? 'test failed' }));
    if (Array.isArray(j?.models) && j.models.length) setProviders((ps) => ps.map((x) => (x.id === p.id ? { ...x, models: j.models } : x)));
    void load();
  };
  const toggle = async (p: Provider) => {
    setBusy(p.id);
    await post(p.id, { action: p.enabled ? 'disable' : 'enable' });
    setBusy(null);
    void load();
  };
  const disconnect = async (p: Provider) => {
    setBusy(p.id);
    await fetch('/api/models', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: p.id }) }).catch(() => null);
    setBusy(null);
    setNote((n) => ({ ...n, [p.id]: '' }));
    void load();
  };
  const copyModel = (ref: string) => {
    navigator.clipboard?.writeText(ref).catch(() => {});
    setCopied(ref);
    setTimeout(() => setCopied((c) => (c === ref ? null : c)), 1200);
  };

  const cloud = providers.filter((p) => !p.local);
  const local = providers.filter((p) => p.local);

  const card = (p: Provider) => {
    const needsSetup = (p.requiresKey && !p.hasCredential) || (p.allowBaseUrl && !p.baseUrl);
    return (
      <section key={p.id} className={`rounded-lg-t border bg-os-surface p-4 ${p.enabled ? 'border-os-border' : 'border-os-border opacity-60'}`}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${STATUS_DOT[p.status]}`} />
              <h3 className="text-[14px] font-bold">{p.name}</h3>
            </div>
            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-os-dim">{p.status.replace('_', ' ')}</div>
          </div>
          <a href={p.docsUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] text-os-muted hover:text-os-text">
            <ExternalLink className="h-3 w-3" /> {p.requiresKey ? 'Get key' : 'Docs'}
          </a>
        </div>

        {/* config inputs */}
        {(needsSetup || p.allowBaseUrl) && (
          <div className="mt-3 flex flex-col gap-1.5">
            {p.allowBaseUrl && (
              <input
                value={urlInput[p.id] ?? p.baseUrl ?? ''}
                onChange={(e) => setUrlInput((u) => ({ ...u, [p.id]: e.target.value }))}
                placeholder="Base URL (e.g. http://localhost:11434/v1)"
                className="rounded border border-os-border bg-os-bg px-2 py-1.5 font-mono text-[11px] text-os-text placeholder:text-os-dim focus:border-os-border-bright focus:outline-none"
              />
            )}
            <div className="flex gap-1.5">
              <input
                type="password"
                value={keyInput[p.id] ?? ''}
                onChange={(e) => setKeyInput((k) => ({ ...k, [p.id]: e.target.value }))}
                placeholder={p.requiresKey ? `Paste ${p.name} API key` : 'API key (optional)'}
                className="min-w-0 flex-1 rounded border border-os-border bg-os-bg px-2 py-1.5 text-[11.5px] text-os-text placeholder:text-os-dim focus:border-os-border-bright focus:outline-none"
              />
              <button onClick={() => connect(p)} disabled={busy === p.id} className="flex items-center gap-1 rounded border border-os-border-bright bg-os-text px-2.5 py-1.5 text-[11px] font-semibold text-os-bg hover:opacity-90 disabled:opacity-50">
                {busy === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />} {p.hasCredential || p.baseUrl ? 'Save' : 'Connect'}
              </button>
            </div>
          </div>
        )}

        {/* actions */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {p.hasCredential && <span className="flex items-center gap-1 rounded border border-os-ok/40 px-2 py-0.5 text-[10px] text-os-ok"><Check className="h-3 w-3" /> key set</span>}
          <button onClick={() => test(p)} disabled={busy === p.id} className="flex items-center gap-1 text-[10.5px] text-os-muted hover:text-os-text"><RefreshCw className="h-3 w-3" /> Test</button>
          <button onClick={() => toggle(p)} disabled={busy === p.id} className="flex items-center gap-1 text-[10.5px] text-os-muted hover:text-os-text"><Power className="h-3 w-3" /> {p.enabled ? 'Disable' : 'Enable'}</button>
          {(p.hasCredential || p.baseUrl) && (
            <button onClick={() => disconnect(p)} disabled={busy === p.id} className="flex items-center gap-1 text-[10.5px] text-os-err hover:opacity-90"><X className="h-3 w-3" /> Remove</button>
          )}
        </div>

        {note[p.id] && <p className="mt-2 font-mono text-[10px] text-os-muted">{note[p.id]}</p>}
        {p.lastError && !note[p.id] && <p className="mt-2 font-mono text-[10px] text-os-err">last error: {p.lastError}</p>}

        {p.models.length > 0 && (
          <div className="mt-3">
            <div className="text-[9px] uppercase tracking-[0.2em] text-os-dim">models — click to copy the id</div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {p.models.slice(0, 24).map((m) => {
                const ref = `${p.id}:${m}`;
                return (
                  <button key={m} onClick={() => copyModel(ref)} title={`Copy "${ref}"`} className="flex items-center gap-1 rounded-sm-t border border-os-border bg-os-bg px-1.5 py-0.5 font-mono text-[9.5px] text-os-muted hover:border-os-border-bright hover:text-os-text">
                    {copied === ref ? <Check className="h-2.5 w-2.5 text-os-ok" /> : <Copy className="h-2.5 w-2.5" />}
                    {m}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-os-dim">Provider connections · cloud</div>
        <div className="grid gap-3 md:grid-cols-2">{cloud.map(card)}</div>
      </div>

      {local.length > 0 && (
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-os-dim">Provider connections · local</div>
          <div className="grid gap-3 md:grid-cols-2">{local.map(card)}</div>
        </div>
      )}

      {/* Brains — Hermes is a runtime, not an API-key provider */}
      {brain && (
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-os-dim">Brains</div>
          <section className="rounded-lg-t border border-os-border bg-os-surface p-4">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-os-muted" />
              <h3 className="text-[14px] font-bold">{brain.name}</h3>
              <span className="rounded border border-os-border px-2 py-0.5 font-mono text-[9.5px] text-os-muted">transport: {brain.transport}</span>
              {brain.isActive && <span className="rounded border border-os-ok/40 px-2 py-0.5 font-mono text-[9.5px] text-os-ok">active brain</span>}
            </div>
            <p className="mt-2 font-mono text-[10.5px] text-os-muted">
              Active provider: {brain.activeProvider} · health: {brain.status} (not probed — shown truthfully rather than a fake “connected”).
            </p>
            <p className="mt-1 font-mono text-[10px] text-os-dim">
              Set an agent&apos;s strategy to <span className="text-os-text">Hermes</span> on /agents to run it through this brain (tools · MCP · memory).
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
