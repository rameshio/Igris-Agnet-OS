'use client';

/**
 * "Send test message" control on the connected Telegram tile — the end-to-end
 * proof that the bot works. Find recent chats (the bot must have been messaged
 * first), pick one, send. Posts to /api/connections/telegram/test.
 */
import { useState } from 'react';
import { Send, Loader2, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

type Chat = { chatId: string; name: string };

export function TelegramTest() {
  const [open, setOpen] = useState(false);
  const [chatId, setChatId] = useState('');
  const [text, setText] = useState('✅ IGRIS connected — test message');
  const [chats, setChats] = useState<Chat[]>([]);
  const [loadedChats, setLoadedChats] = useState(false);
  const [loadingChats, setLoadingChats] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const loadChats = async () => {
    setLoadingChats(true);
    const res = await fetch('/api/connections/telegram/test').catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    setChats(Array.isArray(json.chats) ? json.chats : []);
    setLoadedChats(true);
    setLoadingChats(false);
  };

  const send = async () => {
    if (!chatId.trim()) {
      setResult({ ok: false, detail: 'Enter or pick a chat id first.' });
      return;
    }
    setBusy(true);
    setResult(null);
    const res = await fetch('/api/connections/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: chatId.trim(), text }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({ ok: false, detail: 'request failed' })) : { ok: false, detail: 'request failed' };
    setBusy(false);
    setResult({ ok: Boolean(json.ok), detail: json.detail ?? (json.ok ? 'sent' : 'failed') });
  };

  const inputClass =
    'w-full rounded border border-os-border bg-os-bg px-2 py-1.5 text-[11px] text-os-text placeholder:text-os-dim focus:border-os-border-bright focus:outline-none';

  return (
    <div className="mt-2 border-t border-os-border pt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-[10px] uppercase tracking-widest text-os-dim hover:text-os-text"
      >
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        Send test message
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <div className="flex gap-1.5">
            <input
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="Chat id (e.g. 123456789)"
              className={`${inputClass} font-mono`}
            />
            <button
              onClick={loadChats}
              title="Find chats that have messaged the bot"
              className="flex shrink-0 items-center gap-1 rounded border border-os-border px-2 text-[10px] text-os-muted hover:text-os-text"
            >
              {loadingChats ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Find
            </button>
          </div>

          {loadedChats && (
            <div className="flex flex-wrap gap-1">
              {chats.length > 0 ? (
                chats.map((c) => (
                  <button
                    key={c.chatId}
                    onClick={() => setChatId(c.chatId)}
                    className={`rounded border px-1.5 py-0.5 font-mono text-[9.5px] ${
                      chatId === c.chatId ? 'border-os-border-bright bg-os-surface2 text-os-text' : 'border-os-border text-os-muted hover:text-os-text'
                    }`}
                  >
                    {c.name} · {c.chatId}
                  </button>
                ))
              ) : (
                <span className="text-[9.5px] text-os-dim">
                  No chats yet — message your bot on Telegram first (send it “/start”), then Find again.
                </span>
              )}
            </div>
          )}

          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message text" className={inputClass} />

          <button
            onClick={send}
            disabled={busy}
            className="flex items-center gap-1.5 rounded border border-os-border-bright bg-os-text px-2.5 py-1 text-[11px] font-semibold text-os-bg hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            Send
          </button>

          {result && (
            <p className={`font-mono text-[10px] ${result.ok ? 'text-os-ok' : 'text-os-err'}`}>
              {result.ok ? '✓ ' : '✗ '}
              {result.detail}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
