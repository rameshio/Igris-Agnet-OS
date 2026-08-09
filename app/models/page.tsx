import { PageHeader } from '@/components/PageHeader';
import { ModelsBoard } from '@/components/ModelsBoard';

export const dynamic = 'force-dynamic';

export default function ModelsPage() {
  return (
    <div>
      <PageHeader eyebrow="models" title="Model Providers" />
      <p className="mb-5 max-w-2xl text-[12px] leading-relaxed text-os-muted">
        Connect a provider with its API key, then any of its models can power an agent. To put an
        agent on a specific model, copy a model id below and paste it into that agent&apos;s{' '}
        <span className="font-mono text-os-text">Model</span> field on{' '}
        <a href="/agents" className="text-os-text underline underline-offset-2">
          /agents
        </a>
        . Agents with no model set keep running on your default brain (Hermes). Keys are stored
        locally in <span className="font-mono">.env.local</span> and never shown again.
      </p>
      <ModelsBoard />
    </div>
  );
}
