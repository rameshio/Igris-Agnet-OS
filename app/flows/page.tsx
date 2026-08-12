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
        . Create and version workflows, place typed nodes, and wire them. Input, AI Agent, Output,
        Transform, Decision, Parallel, and Join nodes execute on published versions — with structured
        field mapping, <code>{'{{Node.field}}'}</code> references, and conditional branching. Human
        Approval and Memory nodes are clearly marked as not yet runnable.
      </p>
      <FlowWorkspace agents={agents} />
    </div>
  );
}
