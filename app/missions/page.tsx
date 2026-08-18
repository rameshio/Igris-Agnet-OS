/**
 * Company · Missions (Architecture V2 · F0.2) — the canonical company-work
 * surface: create Missions, break them into Company Tasks, set required
 * capabilities, inspect capability-eligible agents (F0.1), manually assign, and
 * record simple dependencies. This is planning/organization only — nothing here
 * runs a workflow, delegates, or grants authority (that is F1).
 *
 * Distinct from `/tasks` (the lightweight per-agent kanban over `agent_tasks`).
 */
import { getDb } from '@/lib/data';
import { listMissions } from '@/lib/company/service';
import { PageHeader } from '@/components/PageHeader';
import { MissionsBoard } from '@/components/MissionsBoard';

export const dynamic = 'force-dynamic';

export default function MissionsPage() {
  const missions = listMissions(getDb());
  return (
    <div>
      <PageHeader eyebrow="company" title="Missions" />
      <p className="mb-4 max-w-2xl text-[11.5px] text-os-muted">
        A <b>Mission</b> is a company objective; a <b>Company Task</b> is a unit of work toward it. Set required
        capabilities on a task to see which agents could perform it (F0.1) and assign one. F0.2 stores and organizes
        work — the Manager (F1) will orchestrate it. Human Approval stays authoritative (Phase&nbsp;E).
      </p>
      <MissionsBoard initialMissions={missions} />
    </div>
  );
}
