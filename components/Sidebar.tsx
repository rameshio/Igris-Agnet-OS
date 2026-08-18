'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { NAV_OPERATE, NAV_AGENTS, NAV_INTELLIGENCE, NAV_SYSTEM, NAV_LIBRARY, type NavItem } from '@/lib/nav';
import { NAV_COLLAPSE_KEY, navWidth, serializeBoolPref, parseBoolPref } from '@/lib/layout-prefs';

function NavGroup({ title, items, pathname, collapsed }: { title: string; items: NavItem[]; pathname: string; collapsed: boolean }) {
  return (
    <>
      {!collapsed && (
        <div className="px-2.5 pb-1.5 pt-3.5 font-mono text-[9px] uppercase tracking-[0.18em] text-os-dim">{title}</div>
      )}
      {collapsed && <div className="mt-3 first:mt-1.5 h-px bg-os-border/60" aria-hidden />}
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || (href !== '/' && pathname.startsWith(`${href}/`));
        return (
          <Link
            key={href}
            href={href}
            title={collapsed ? label : undefined}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center rounded-sm-t border text-[13.5px] font-medium transition-colors ${
              collapsed ? 'justify-center px-0 py-[9px]' : 'gap-2.5 px-2.5 py-[7px]'
            } ${
              active
                ? 'border-[var(--accent-line)] bg-[var(--accent-soft)] text-os-accent'
                : 'border-transparent text-os-muted hover:bg-os-surface2 hover:text-os-text'
            }`}
          >
            <Icon className="h-[15px] w-[15px] shrink-0 opacity-85" strokeWidth={1.7} />
            {!collapsed && label}
          </Link>
        );
      })}
    </>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [live, setLive] = useState<{ up: number; total: number } | null>(null);
  // Start expanded so the FIRST client render matches the server (no hydration
  // mismatch), then hydrate the persisted preference after mount. The pre-paint
  // init script already applied --nav-w, so the width does not flash.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(parseBoolPref(localStorage.getItem(NAV_COLLAPSE_KEY)));
    } catch {
      /* storage unavailable — stay expanded */
    }
  }, []);

  // Apply the collapse state to the shell (content offset + sidebar width) on
  // mount and on every change. The <head> init script handles the pre-paint
  // no-flash case on a full load; this effect keeps things correct even after a
  // client-side transition (when that inline script does not re-run).
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--nav-w', `${navWidth(collapsed)}px`);
    root.setAttribute('data-nav', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(NAV_COLLAPSE_KEY, serializeBoolPref(next));
      } catch {
        /* preferences are best-effort */
      }
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    fetch('/api/connections')
      .then((res) => res.json())
      .then((body: { connections?: { state: string }[] }) => {
        if (cancelled || !Array.isArray(body.connections)) return;
        setLive({
          up: body.connections.filter((c) => c.state === 'connected').length,
          total: body.connections.length,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <aside
      suppressHydrationWarning
      style={{ width: 'var(--nav-w, 232px)' }}
      className="os-sidebar fixed inset-y-0 left-0 z-20 flex flex-col overflow-hidden border-r border-os-border bg-os-bg2 transition-[width] duration-150"
    >
      <div className={`flex items-center pt-5 ${collapsed ? 'justify-center px-2 pb-3' : 'gap-[11px] px-[18px] pb-[18px]'}`}>
        {!collapsed ? (
          <div className="min-w-0">
            <div className="truncate text-[13px] font-bold tracking-[0.14em]">IGRIS AGENT</div>
            <div className="mt-[3px] whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.16em] text-os-dim">
              v3 · Operator Mode
            </div>
          </div>
        ) : (
          <div className="grid h-7 w-7 place-items-center rounded-sm-t border border-os-border bg-os-surface text-[11px] font-bold tracking-[0.1em] text-os-text" title="IGRIS AGENT">
            IA
          </div>
        )}
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2">
        <NavGroup title="Operate" items={NAV_OPERATE} pathname={pathname} collapsed={collapsed} />
        <NavGroup title="Agents" items={NAV_AGENTS} pathname={pathname} collapsed={collapsed} />
        <NavGroup title="Intelligence" items={NAV_INTELLIGENCE} pathname={pathname} collapsed={collapsed} />
        <NavGroup title="System" items={NAV_SYSTEM} pathname={pathname} collapsed={collapsed} />
        <NavGroup title="Variants" items={NAV_LIBRARY} pathname={pathname} collapsed={collapsed} />
      </nav>
      <div className={`flex flex-col gap-2 border-t border-os-border py-3 ${collapsed ? 'items-center px-2' : 'px-[18px]'}`}>
        <button
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`flex items-center rounded-sm-t border border-os-border text-os-muted transition-colors hover:border-os-border-strong hover:text-os-text ${
            collapsed ? 'h-8 w-8 justify-center' : 'gap-2 px-2.5 py-1.5 text-[11px]'
          }`}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <><PanelLeftClose className="h-3.5 w-3.5" /> Collapse</>}
        </button>
        {!collapsed && (
          <>
            <div className="flex items-center gap-2 whitespace-nowrap font-mono text-[10px] text-os-muted">
              <span className="dot ok pulse" /> {live ? `${live.up}/${live.total}` : '—/—'} systems live
            </div>
            <div className="whitespace-nowrap font-mono text-[10px] text-os-dim">localhost:4100 · sqlite · real agents</div>
          </>
        )}
      </div>
    </aside>
  );
}
