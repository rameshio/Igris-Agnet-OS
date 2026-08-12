import { PageHeader } from '@/components/PageHeader';
import { ApprovalsInbox } from '@/components/ApprovalsInbox';

export const dynamic = 'force-dynamic';

export default function ApprovalsPage() {
  return (
    <div>
      <PageHeader eyebrow="flows" title="Approvals" />
      <p className="mb-4 max-w-2xl text-[11.5px] text-os-muted">
        Human approval gates. A workflow that reaches a Human Approval node pauses durably until you
        approve or reject here — the run survives refresh and restart, and continues down the chosen route.
      </p>
      <ApprovalsInbox />
    </div>
  );
}
