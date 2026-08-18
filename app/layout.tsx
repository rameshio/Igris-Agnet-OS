import type { Metadata } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { Commander } from '@/components/Commander';
import { ConductorPanel } from '@/components/ConductorPanel';
import { ActivityDock } from '@/components/ActivityDock';
import { ContextRouteSync } from '@/components/ContextRouteSync';
import { getDb } from '@/lib/data';
import type { Command } from '@/lib/palette';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import { NAV_INIT_SCRIPT } from '@/lib/layout-prefs';

const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'IGRIS AGENT',
  description: 'IGRIS Agent — personal operating system and AI agent command center',
};

const NAV_COMMANDS: Command[] = [
  { id: 'nav-home', label: 'Home', keywords: 'dashboard today overview start', href: '/', hint: 'view' },
  { id: 'nav-social', label: 'Social', keywords: 'instagram tiktok twitter x youtube linkedin followers growth', href: '/social', hint: 'view' },
  { id: 'nav-comms', label: 'Comms', keywords: 'messages email whatsapp slack inbox unified feed', href: '/comms', hint: 'view' },
  { id: 'nav-agents', label: 'Agents', keywords: 'runtime run real roster', href: '/agents', hint: 'view' },
  { id: 'nav-connections', label: 'Connections', keywords: 'integrations tools status creds', href: '/integrations', hint: 'view' },
  { id: 'nav-roadmap', label: 'Roadmap', keywords: 'plan phases quarters', href: '/roadmap', hint: 'view' },
  { id: 'nav-analytics', label: 'Analytics', keywords: 'metrics numbers', href: '/analytics', hint: 'view' },
  { id: 'nav-reference', label: 'Reference Model', keywords: 'domains business brm', href: '/reference', hint: 'view' },
  { id: 'nav-org', label: 'Org Chart', keywords: 'org chart hierarchy departments tree structure leads specialists', href: '/org', hint: 'view' },
  { id: 'nav-brain', label: 'G-Brain', keywords: 'brain knowledge core markdown vector pgvector supabase embeddings zeroentropy graph doctor', href: '/brain', hint: 'view' },
  { id: 'nav-settings', label: 'Settings', keywords: 'settings workspace reset clear demo start clean', href: '/settings', hint: 'view' },
];

function buildCommands(): Command[] {
  const db = getDb();
  const tools: Command[] = db.tools.all().map((t) => ({
    id: `tool-${t.id}`,
    label: t.name,
    keywords: `${t.category} ${t.description}`,
    href: '/integrations',
    hint: 'tool',
  }));
  const agents: Command[] = db.agents.all().map((a) => ({
    id: `agent-${a.id}`,
    label: a.name,
    keywords: `${a.role} ${a.description}`,
    href: '/agents',
    hint: 'agent',
  }));
  return [...NAV_COMMANDS, ...agents, ...tools];
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontMono.variable} suppressHydrationWarning>
      <head>
        {/* Apply the persisted theme before first paint — no dark↔light flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* Apply the persisted sidebar width before first paint — no layout flash. */}
        <script dangerouslySetInnerHTML={{ __html: NAV_INIT_SCRIPT }} />
      </head>
      <body>
        <ContextRouteSync />
        <Sidebar />
        {/* os-shell yields to the Conductor dock: the panel sets --conductor-w
            and the whole content column glides left instead of being covered */}
        <div className="os-shell ml-[var(--nav-w,232px)] flex min-h-screen min-w-0 flex-col transition-[margin] duration-150" style={{ marginRight: 'calc(var(--conductor-w, 0px) + var(--activity-w, 0px))' }}>
          <Topbar />
          <main className="min-w-0 flex-1 px-8 pb-16 pt-7 wide:px-10 ultra:px-12">
            {/* Width tiers: 1280 on laptops · 1760 on large monitors ·
                full-bleed on 32"/ultrawide. See tailwind screens wide/ultra. */}
            <div className="mx-auto max-w-[1280px] wide:max-w-[1760px] ultra:max-w-none">
              {children}
            </div>
          </main>
        </div>
        {/* U2: the unified Commander (Ctrl/Cmd+K) supersedes the old CommandPalette. */}
        <Commander commands={buildCommands()} />
        {/* Notion-style agent dock — the Conductor, aware of the current screen */}
        <ConductorPanel />
        {/* U4: read-only Activity / Ops stream (right dock, collapsible) */}
        <ActivityDock />
      </body>
    </html>
  );
}
