/**
 * Company Intelligence (Architecture V2 · F6) — the analytical/decision-support
 * surface over the company work built in F0–F5. Distinct from `/brain` (knowledge
 * + structural/operational graphs): this is derived, read-only analysis. The
 * dashboard is a client component that fetches ONE bounded snapshot API.
 */
import { PageHeader } from '@/components/PageHeader';
import { CompanyIntelligence } from '@/components/CompanyIntelligence';

export const dynamic = 'force-dynamic';

export default function IntelligencePage() {
  return (
    <div>
      <PageHeader eyebrow="decision support" title="Intelligence" caret />
      <div className="mt-5">
        <CompanyIntelligence />
      </div>
    </div>
  );
}
