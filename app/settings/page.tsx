import { getDb } from '@/lib/data';
import { PageHeader } from '@/components/PageHeader';
import { ResetWorkspace } from '@/components/ResetWorkspace';
import { BrainSettings } from '@/components/BrainSettings';
import { HermesRuntimeSettings } from '@/components/HermesRuntimeSettings';
import { Label } from '@/components/terminal';
import { activeLlmProviderName } from '@/lib/connectors/llm';
import { readEnvLocal } from '@/lib/creds';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  const db = getDb();
  const demoCleared = db.meta.get('demo_cleared') === '1';
  const brainProvider = activeLlmProviderName();
  const hermesBin = readEnvLocal().HERMES_CLI_BIN ?? 'hermes';
  const stats: [string, number][] = [
    ['Built-in agents', db.agents.all().length],
    ['Custom agents', db.customAgents.all().length],
    ['Departments', db.departments.all().length],
    ['Funnel contacts', db.funnel.journeys().length],
  ];

  return (
    <div>
      <PageHeader eyebrow="system" title="Settings" />

      <div className="mb-6 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2">
        {stats.map(([label, value]) => (
          <div key={label} className="hoverable flex flex-col gap-1.5 rounded-lg-t border border-os-border bg-os-surface px-4 py-3">
            <Label>{label}</Label>
            <div className="font-mono text-[24px] font-semibold tracking-[-0.02em]">{value}</div>
          </div>
        ))}
      </div>

      <div className="mb-6 rounded-lg-t border border-os-border bg-os-surface p-4">
        <div className="text-[10px] uppercase tracking-[0.26em] text-os-dim">// workspace status</div>
        <h2 className="mt-1 text-[15px] font-bold">{demoCleared ? 'Clean workspace' : 'Demo workspace'}</h2>
        <p className="mt-0.5 text-[11.5px] text-os-muted">
          {demoCleared
            ? 'Seeded demo data has been cleared. New data comes only from what you and your agents create.'
            : 'Running the seeded demo dataset. Use the danger zone below to start clean for a real client.'}
        </p>
      </div>

      <BrainSettings initialProvider={brainProvider} initialHermesBin={hermesBin} />

      <HermesRuntimeSettings />

      <ResetWorkspace demoCleared={demoCleared} />
    </div>
  );
}
