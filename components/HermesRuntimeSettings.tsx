'use client';

/**
 * Hermes Runtime settings (HRA-2, H2). Truthful status of the LOCAL Hermes
 * runtime — installation, serve reachability, ownership, health, capabilities,
 * token presence, and the persistent-memory boundary. Actions are explicit
 * (Detect / Check Health / Configure / Start / Stop). It NEVER shows a token and
 * NEVER implies serve is powering agents — production transport stays ACP.
 */
import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Search, Play, Square, X } from 'lucide-react';
import type { Tri } from '@/lib/connectors/hermes-client';
import type { RuntimeStatus, RuntimeState } from '@/lib/connectors/hermes-runtime';

type Status = RuntimeStatus;
type Action = 'detect' | 'health' | 'start' | 'stop' | 'configure' | 'set_transport';

const STATE_TONE: Record<RuntimeState, string> = {
  healthy: 'text-os-ok',
  degraded: 'text-os-warn',
  starting: 'text-os-warn',
  installed: 'text-os-muted',
  stopped: 'text-os-muted',
  unreachable: 'text-os-err',
  crashed: 'text-os-err',
  not_installed: 'text-os-err',
};
const STATE_LABEL: Record<RuntimeState, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  starting: 'Starting…',
  installed: 'Installed · serve not running',
  stopped: 'Stopped',
  unreachable: 'Unreachable',
  crashed: 'Crashed',
  not_installed: 'Not installed',
};
const cap = (v: Tri): string => (v === true ? '✓' : v === false ? '✗' : '?');

export function HermesRuntimeSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<false | Action | 'load'>('load');
  const [note, setNote] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [form, setForm] = useState({ mode: 'external_local', host: '127.0.0.1', port: '9119', binPath: '', token: '' });

  const load = async () => {
    const r = await fetch('/api/settings/hermes-runtime').catch(() => null);
    const j = r ? ((await r.json().catch(() => null)) as Status | null) : null;
    if (j) {
      setStatus(j);
      setForm((f) => ({ ...f, mode: j.mode, host: j.endpoint.host, port: String(j.endpoint.port), binPath: j.binaryPath ?? '' }));
    }
  };
  useEffect(() => {
    void load().finally(() => setBusy(false));
  }, []);

  const act = async (action: Action, body: Record<string, unknown> = {}) => {
    setBusy(action);
    setNote(null);
    const r = await fetch('/api/settings/hermes-runtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    }).catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    setBusy(false);
    if (!r?.ok || !j?.ok) {
      setNote(j?.error ?? 'Action failed.');
      if (j?.status) setStatus(j.status);
      return;
    }
    if (j.status) setStatus(j.status);
    if (action === 'configure') setShowConfig(false);
    setNote(action === 'health' ? 'Health checked.' : action === 'detect' ? 'Detection complete.' : action === 'configure' ? 'Saved.' : null);
  };

  const s = status;
  const btn = 'flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-50';
  const row = (k: string, v: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-[10px] uppercase tracking-[0.14em] text-os-dim">{k}</span>
      <span className="text-right font-mono text-[11px] text-os-text">{v}</span>
    </div>
  );

  return (
    <div className="mb-6 rounded-lg-t border border-os-border bg-os-surface p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.26em] text-os-dim">// hermes runtime</div>
          <h2 className="mt-1 text-[15px] font-bold">Hermes Runtime</h2>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => act('detect')} disabled={!!busy} className={`${btn} border-os-border text-os-muted hover:text-os-text`}>
            {busy === 'detect' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />} Detect
          </button>
          <button onClick={() => act('health')} disabled={!!busy} className={`${btn} border-os-border text-os-muted hover:text-os-text`}>
            {busy === 'health' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Check health
          </button>
        </div>
      </div>

      {note && (
        <p className="mt-2 flex items-center gap-1.5 font-mono text-[10.5px] text-os-muted">
          {note}
          <button onClick={() => setNote(null)} className="text-os-dim hover:text-os-text"><X className="h-3 w-3" /></button>
        </p>
      )}

      {busy === 'load' || !s ? (
        <p className="mt-3 font-mono text-[11px] text-os-dim">Loading runtime status…</p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-4 max-[760px]:grid-cols-1">
          {/* Installation + Runtime */}
          <div className="rounded border border-os-border bg-os-bg p-3">
            <div className="mb-1 text-[9.5px] uppercase tracking-[0.2em] text-os-dim">installation</div>
            {row('Hermes Agent', s.installed ? 'Installed' : 'Not installed')}
            {row('Version', s.version ?? '—')}
            {row('Path', <span className="break-all">{s.binaryPath ?? '—'}</span>)}
            <div className="mb-1 mt-3 text-[9.5px] uppercase tracking-[0.2em] text-os-dim">runtime</div>
            {row('State', <span className={STATE_TONE[s.state]}>{STATE_LABEL[s.state]}</span>)}
            {row('Mode', s.mode)}
            {row('Ownership', s.ownership === 'managed' ? 'IGRIS-managed' : s.ownership === 'external' ? 'External / shared' : 'Unknown')}
            {row('Endpoint', `${s.endpoint.host}:${s.endpoint.port}`)}
            {row('serve reachable', s.serveReachable ? 'yes' : 'no')}
            {s.managedProcess && row('Managed PID', `${s.managedProcess.pid} · since ${new Date(s.managedProcess.startedAt).toLocaleTimeString()}`)}
          </div>

          {/* Health + Capabilities + Security */}
          <div className="rounded border border-os-border bg-os-bg p-3">
            <div className="mb-1 text-[9.5px] uppercase tracking-[0.2em] text-os-dim">health (GET /api/status)</div>
            {row('Overall', s.health?.reachable && s.health.isHermes ? (s.health.overall ?? 'ok') : 'unreachable')}
            {row('Gateway mode', s.health?.gatewayMode ?? '—')}
            {row('Active sessions', s.health?.activeSessions ?? '—')}
            {row('Last check', s.lastCheckAt ? new Date(s.lastCheckAt).toLocaleTimeString() : '—')}
            <div className="mb-1 mt-3 text-[9.5px] uppercase tracking-[0.2em] text-os-dim">capabilities (? = unverified)</div>
            <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 font-mono text-[10.5px] text-os-muted">
              <span>Chat {cap(s.capabilities.chat)}</span>
              <span>Stream {cap(s.capabilities.streaming)}</span>
              <span>Tools {cap(s.capabilities.tools)}</span>
              <span>MCP {cap(s.capabilities.mcp)}</span>
              <span>Skills {cap(s.capabilities.skills)}</span>
              <span>Cancel {cap(s.capabilities.cancellation)}</span>
              <span>Multi {cap(s.capabilities.multiSession)}</span>
              <span>Health {s.capabilities.healthProbe ? '✓' : '✗'}</span>
              <span>Memory ●</span>
            </div>
            <div className="mb-1 mt-3 text-[9.5px] uppercase tracking-[0.2em] text-os-dim">security</div>
            {row('Session token', s.tokenConfigured ? 'Configured' : 'Missing')}
          </div>
        </div>
      )}

      {s && (
        <>
          {/* Production transport selector (H3) — explicit, reversible, no silent fallback */}
          <div className="mt-3 rounded border border-os-border bg-os-bg p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[9.5px] uppercase tracking-[0.2em] text-os-dim">production agent transport</span>
              <span className="font-mono text-[10px] text-os-text">
                current: <span className={s.productionTransport === 'serve' ? 'text-os-warn' : 'text-os-ok'}>{s.productionTransport.toUpperCase()}</span>
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => act('set_transport', { transport: 'acp' })}
                disabled={!!busy || s.productionTransport === 'acp'}
                className={`${btn} border-os-border ${s.productionTransport === 'acp' ? 'bg-os-text text-os-bg' : 'text-os-muted hover:text-os-text'}`}
              >
                Use ACP (default / rollback)
              </button>
              <button
                onClick={() => act('set_transport', { transport: 'serve' })}
                disabled={!!busy || s.productionTransport === 'serve' || !s.eligibility.eligible}
                title={s.eligibility.eligible ? 'Route agent traffic through hermes serve' : `Not eligible: ${s.eligibility.reasons.join('; ')}`}
                className={`${btn} border-os-border ${s.productionTransport === 'serve' ? 'bg-os-text text-os-bg' : 'text-os-muted hover:text-os-text'}`}
              >
                Use Serve {s.eligibility.eligible ? '' : '(ineligible)'}
              </button>
            </div>
            {!s.eligibility.eligible && (
              <p className="mt-1.5 font-mono text-[9.5px] text-os-dim">Serve requires: {s.eligibility.reasons.join(' · ')}</p>
            )}
            {s.productionTransport === 'serve' && (
              <p className="mt-1.5 font-mono text-[9.5px] text-os-warn">⚠ Agent traffic is routed through hermes serve. No silent fallback — a serve failure surfaces as Hermes unavailable. Use ACP to roll back.</p>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="rounded border border-os-border px-2 py-1 font-mono text-[9.5px] text-os-warn" title={s.memory.note}>
              Hermes memory: persistent across sessions — separate from G-Brain
            </span>
          </div>

          {/* Lifecycle actions (safe): start only if not already external-healthy; stop only owned */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {s.installed && s.ownership !== 'external' && (
              <button onClick={() => act('start')} disabled={!!busy} className={`${btn} border-os-border-bright bg-os-text text-os-bg hover:opacity-90`}>
                {busy === 'start' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Start local runtime
              </button>
            )}
            {s.ownership === 'managed' && (
              <button onClick={() => act('stop')} disabled={!!busy} className={`${btn} border-os-border text-os-muted hover:text-os-err`}>
                {busy === 'stop' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />} Stop (managed)
              </button>
            )}
            <button onClick={() => setShowConfig((v) => !v)} disabled={!!busy} className={`${btn} border-os-border text-os-muted hover:text-os-text`}>
              Configure
            </button>
          </div>

          {showConfig && (
            <div className="mt-3 grid grid-cols-2 gap-2 rounded border border-os-border bg-os-bg p-3 max-[760px]:grid-cols-1">
              <label className="text-[10px] text-os-dim">Mode
                <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })} className="mt-1 w-full rounded border border-os-border bg-os-surface px-2 py-1 text-[11px] text-os-text">
                  <option value="external_local">External local</option>
                  <option value="managed_local">Managed local</option>
                </select>
              </label>
              <label className="text-[10px] text-os-dim">Executable path (optional)
                <input value={form.binPath} onChange={(e) => setForm({ ...form, binPath: e.target.value })} placeholder="auto-detect" className="mt-1 w-full rounded border border-os-border bg-os-surface px-2 py-1 text-[11px] text-os-text placeholder:text-os-dim" />
              </label>
              <label className="text-[10px] text-os-dim">Host
                <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} className="mt-1 w-full rounded border border-os-border bg-os-surface px-2 py-1 text-[11px] text-os-text" />
              </label>
              <label className="text-[10px] text-os-dim">Port
                <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} className="mt-1 w-full rounded border border-os-border bg-os-surface px-2 py-1 text-[11px] text-os-text" />
              </label>
              <label className="col-span-2 text-[10px] text-os-dim max-[760px]:col-span-1">Session token (write-only — stored backend-side, never shown)
                <input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder={s.tokenConfigured ? '•••••••• (configured)' : 'paste to configure'} className="mt-1 w-full rounded border border-os-border bg-os-surface px-2 py-1 text-[11px] text-os-text placeholder:text-os-dim" />
              </label>
              <div className="col-span-2 max-[760px]:col-span-1">
                <button
                  onClick={() =>
                    act('configure', {
                      mode: form.mode,
                      host: form.host.trim() || undefined,
                      port: Number(form.port) || undefined,
                      binPath: form.binPath.trim() || undefined,
                      token: form.token.trim() || undefined,
                    }).then(() => setForm((f) => ({ ...f, token: '' })))
                  }
                  disabled={!!busy}
                  className={`${btn} border-os-border-bright bg-os-text text-os-bg hover:opacity-90`}
                >
                  {busy === 'configure' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Save configuration
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
