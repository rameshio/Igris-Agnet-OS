import type { ReactNode } from 'react';
import { getDb } from '@/lib/data';
import { PageHeader } from '@/components/PageHeader';
import { WorkflowMap } from '@/components/WorkflowMap';
import { WorkflowBuilder } from '@/components/WorkflowBuilder';
import { BrandLogo } from '@/lib/brand-logos';
import { toolBrand } from '@/lib/workflow-tool-brands';
import { INTEGRATIONS } from '@/lib/integrations-catalog';

export const dynamic = 'force-dynamic';

export default function WorkflowsPage() {
  const workflows = getDb().workflows.all();
  // Render the company logos here, server-side: BrandLogo pulls simple-icons,
  // which must never enter the client bundle. The map receives ready-made nodes.
  const toolIds = new Set(workflows.flatMap((w) => w.steps.flatMap((s) => s.tools)));
  const toolLogos: Record<string, ReactNode> = {};
  for (const id of toolIds) {
    const b = toolBrand(id);
    toolLogos[id] = <BrandLogo slug={b.slug} name={b.name} size={14} />;
  }
  // The tool catalog powers the builder's "connect a tool" picker.
  const tools = INTEGRATIONS.map((i) => ({ slug: i.slug, name: i.name, category: i.category }));
  return (
    <div>
      <PageHeader eyebrow="process map" title="Workflows" />
      <WorkflowBuilder tools={tools} initialWorkflows={workflows} />
      <WorkflowMap workflows={workflows} toolLogos={toolLogos} />
    </div>
  );
}
