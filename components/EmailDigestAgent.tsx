'use client';

/**
 * Gmail → Telegram digest agent card. Pick a Telegram chat, choose how many
 * emails, hit Run: it reads recent mail, summarizes via the active brain, and
 * sends the digest to Telegram. Shows exactly which step failed if a
 * prerequisite (Gmail / Telegram / brain) isn't wired.
 */
import { useState } from 'react';
import { Mail, Send, Loader2, RefreshCw, ArrowRight } from 'lucide-react';

type Chat = { chatId: string; name: string };
type Result = { ok: boolean; step: string; detail: string; emailsRead?: number; summary?: string };

export function EmailDigestAgent() {
  const [chatId, setChatId] = useState('');
  const [limit, setLimit] = useState(10);
  const [chats, setChats] = useState<Chat[]>([]);
  const [loadedChats, setLoadedChats] = useState(false);
  const [loadingChats, setLoadingChats] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const findChats = async () => {
    setLoadingChats(true);
    const res = await fetch('/api/connections/telegram/test').catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    setChats(Array.isArray(json.chats) ? json.chats : []);
    setLoadedChats(true);
    setLoadingChats(false);
  };

  const run = async () => {
    if (!chatId.trim()) {
      setResult({ ok: false, step: 'send', detail: 'Pick or enter a Telegram chat id first.' });
      return;
    }
    setBusy(true);
    setResult(null);
    const res = await fetch('/api/agents/email-digest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: chatId.trim(), limit }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({ ok: false, step: 'send', detail: 'request failed' })) : { ok: false, step: 'send', detail: 'request failed' };
    setBusy(false);
    setResult(json);
  };

  const inputClass =
    'rounded border border-os-border bg-os-bg px-2 py-1.5 text-[12px] text-os-text placeholder:text-os-dim focus:border-os-border-bright focus:outline-none';

  return (
    <section className="mb-8 rounded-lg-t border border-os-border bg-os-surface p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.26em] text-os-dim">
        <Mail className="h-3 w-3" /> // ready-made agent
      </div>
      <h2 className="mt-1 flex flex-wrap items-center gap-1.5 text-[15px] font-bold">
        Gmail <ArrowRight className="h-3.5 w-3.5 text-os-dim" /> Telegram Digest
      </h2>
      <p className="mt-0.5 text-[11.5px] text-os-muted">
        Reads your recent email, summarizes it with your brain, and sends the digest to Telegram.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1">
          <label className="mb-1 block text-[9.5px] uppercase tracking-[0.18em] text-os-dim">Telegram chat id</label>
          <div className="flex gap-1.5">
            <input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="123456789" className={`${inputClass} min-w-0 flex-1 font-mono`} />
            <button onClick={findChats} title="Find chats that messaged your bot" className="flex shrink-0 items-center gap-1 rounded border border-os-border px-2 text-[10px] text-os-muted hover:text-os-text">
              {loadingChats ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Find
            </button>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[9.5px] uppercase tracking-[0.18em] text-os-dim">Emails</label>
          <input
            type="number"
            min={1}
            max={25}
            value={limit}
            onChange={(e) => setLimit(Math.min(25, Math.max(1, Number(e.target.value) || 10)))}
            className={`${inputClass} w-20`}
          />
        </div>
        <button
          onClick={run}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-md border border-os-border-bright bg-os-text px-3 py-2 text-[12px] font-semibold text-os-bg hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Run digest
        </button>
      </div>

      {loadedChats && (
        <div className="mt-2 flex flex-wrap gap-1">
          {chats.length > 0 ? (
            chats.map((c) => (
              <button
                key={c.chatId}
                onClick={() => setChatId(c.chatId)}
                className={`rounded border px-1.5 py-0.5 font-mono text-[9.5px] ${chatId === c.chatId ? 'border-os-border-bright bg-os-surface2 text-os-text' : 'border-os-border text-os-muted hover:text-os-text'}`}
              >
                {c.name} · {c.chatId}
              </button>
            ))
          ) : (
            <span className="text-[9.5px] text-os-dim">No chats yet — message your bot on Telegram (send it “/start”), then Find again.</span>
          )}
        </div>
      )}

      {busy && <p className="mt-3 font-mono text-[10.5px] text-os-dim">Working… (with Hermes as the brain this can take ~40s)</p>}

      {result && (
        <div className={`mt-3 rounded border px-3 py-2 ${result.ok ? 'border-os-border' : 'border-os-border'}`}>
          <div className={`font-mono text-[11px] font-bold ${result.ok ? 'text-os-ok' : 'text-os-err'}`}>
            {result.ok ? '✓ Sent to Telegram' : `✗ Failed at: ${result.step}`}
          </div>
          <div className="mt-1 text-[11px] text-os-muted">{result.detail}</div>
          {result.summary && (
            <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-os-bg px-2 py-1.5 font-mono text-[10.5px] leading-snug text-os-text">
              {result.summary}
            </pre>
          )}
        </div>
      )}

      <p className="mt-3 font-mono text-[9px] leading-relaxed text-os-dim">
        Needs: Gmail connected (Connections → Gmail), Telegram connected + your bot messaged once, and a brain set (Settings → Brain).
      </p>
    </section>
  );
}
