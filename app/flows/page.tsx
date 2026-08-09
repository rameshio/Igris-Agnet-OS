import { getDb } from '@/lib/data';
import { allRuntimeAgents } from '@/lib/agents/registry';
import { PageHeader } from '@/components/PageHeader';
import { FlowWorkspace } from '@/components/flows/FlowWorkspace';

export const dynamic = 'force-dynamic';

export default function FlowsPage() {
  const db = getDb();
  const agents = allRuntimeAgents(db)
    .filter((a) => a.id !== 'conductor')
    .map((a) => ({ id: a.id, name: a.name, model: a.model }));

  return (
    <div>
      <PageHeader eyebrow="orchestration" title="G-Brain Flow" />
      <p className="mb-4 max-w-2xl text-[12px] leading-relaxed text-os-muted">
        Build executable workflows by connecting agents, tools, logic, human approvals, and memory.
        This is the orchestration surface — separate from the G-Brain knowledge graph on{' '}
        <a href="/brain" className="text-os-text underline underline-offset-2">
          /brain
        </a>
        . Phase A ships the workflow foundation: create and version workflows, place typed nodes, and
        wire them. Node execution arrives in later phases — unsupported nodes are clearly marked.
      </p>
      <FlowWorkspace agents={agents} />
    </div>
  );
}
