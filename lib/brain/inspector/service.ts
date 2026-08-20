/**
 * Universal Inspector — service (Architecture V2 · F4).
 *
 * Resolves one canonical object into a safe, typed `InspectorView` by READING the owning
 * systems (registry, company core, flow engine, G-Brain Core, Phase E). It exposes safe
 * fields only — never a system prompt, model id, tool credential, or approval `context_json`
 * — and offers only CLOSED, typed actions that route to existing APIs / surfaces.
 */
import type { FounderDb } from '@/lib/db';
import { BrainError } from '@/lib/brain/core/model';
import { getAgentById, getCapabilitiesForAgent } from '@/lib/agents/registry';
import { buildAgentPresence } from '@/lib/agents/presence-service';
import { getMission, getCompanyTask, getTaskDependencies } from '@/lib/company/service';
import { missionReport } from '@/lib/company/manager/service';
import { getArtifact } from '@/lib/company/manager/artifacts';
import { getKnowledge } from '@/lib/brain/core/knowledge';
import { isInspectorKind, type InspectorAction, type InspectorSection, type InspectorView } from '@/lib/brain/inspector/model';

const openMission = (): InspectorAction => ({ id: 'open_mission', kind: 'navigate', label: 'Open in Missions', href: '/missions' });

export function inspectEntity(db: FounderDb, input: { kind: string; id: string }): InspectorView {
  const kind = input.kind === 'company_task' ? 'task' : input.kind;
  if (!isInspectorKind(kind)) throw new BrainError(`unknown inspector kind: ${input.kind}`, 400);
  const id = (input.id ?? '').trim();
  if (!id) throw new BrainError('id required', 400);

  switch (kind) {
    case 'agent': {
      const a = getAgentById(db, id);
      if (!a) throw new BrainError('agent not found', 404);
      const presence = buildAgentPresence(db).find((p) => p.agentId === id);
      const caps = getCapabilitiesForAgent(db, id).map((c) => c.id);
      const sections: InspectorSection[] = [
        { title: 'Overview', rows: [
          { label: 'Role', value: a.role === 'executive_manager' ? 'Executive Manager' : 'Agent' },
          { label: 'Department', value: a.departmentId },
          ...((a as { parentId?: string | null }).parentId ? [{ label: 'Reports to', value: (a as { parentId?: string | null }).parentId as string }] : []),
        ] },
        { title: 'Capabilities', rows: caps.length ? caps.map((c) => ({ label: c, value: '' })) : [{ label: '(none assigned)', value: '' }] },
        { title: 'Status', rows: [{ label: 'Presence', value: presence?.state ?? 'idle' }] },
      ];
      return { entity: { id: `agent:${id}`, kind: 'agent', label: a.name, status: presence?.state }, sections,
        actions: [{ id: 'open_agent', kind: 'navigate', label: 'Open in Agents', href: '/agents' }, { id: 'open_org', kind: 'navigate', label: 'Open in Org', href: '/org' }] };
    }
    case 'mission': {
      const m = getMission(db, id);
      if (!m) throw new BrainError('mission not found', 404);
      const report = missionReport(db, id);
      const c = report.taskCounts;
      const sections: InspectorSection[] = [
        { title: 'Overview', rows: [{ label: 'Status', value: m.status }, { label: 'Priority', value: m.priority }] },
        { title: 'Tasks', rows: [{ label: 'Total', value: String(c.total) }, { label: 'Completed', value: String(c.completed) }, { label: 'Running', value: String(c.running) }, { label: 'Failed', value: String(c.failed) }] },
        { title: 'Blockers', rows: report.blockers.length ? report.blockers.map((b) => ({ label: b.title, value: b.reason.replace('_', ' ') })) : [{ label: '(none)', value: '' }] },
        { title: 'Artifacts', rows: report.artifacts.length ? report.artifacts.map((ar) => ({ label: ar.title, value: ar.type })) : [{ label: '(none)', value: '' }] },
      ];
      return { entity: { id: `mission:${id}`, kind: 'mission', label: m.title, status: m.status }, sections, actions: [openMission()] };
    }
    case 'task': {
      const t = getCompanyTask(db, id);
      if (!t) throw new BrainError('task not found', 404);
      const deps = getTaskDependencies(db, id);
      const sections: InspectorSection[] = [
        { title: 'Overview', rows: [
          { label: 'Status', value: t.status },
          { label: 'Assigned agent', value: t.assignedAgentId ?? '(unassigned)' },
          { label: 'Execution', value: t.executionKind ? `${t.executionKind}:${t.executionRefId ?? ''}` : '(none)' },
        ] },
        { title: 'Required capabilities', rows: t.requiredCapabilities.length ? t.requiredCapabilities.map((cp) => ({ label: cp, value: '' })) : [{ label: '(none)', value: '' }] },
        { title: 'Dependencies', rows: deps.dependsOn.length ? deps.dependsOn.map((d) => ({ label: d.title, value: d.status })) : [{ label: '(none)', value: '' }] },
      ];
      return { entity: { id: `company_task:${id}`, kind: 'task', label: t.title, status: t.status }, sections, actions: [openMission()] };
    }
    case 'artifact': {
      const ar = getArtifact(db, id);
      if (!ar) throw new BrainError('artifact not found', 404);
      const sections: InspectorSection[] = [
        { title: 'Overview', rows: [{ label: 'Type', value: ar.type }, ...(ar.summary ? [{ label: 'Summary', value: ar.summary }] : [])] },
        { title: 'Provenance', rows: [
          ...(ar.missionId ? [{ label: 'Mission', value: ar.missionId }] : []),
          ...(ar.taskId ? [{ label: 'Task', value: ar.taskId }] : []),
          ...(ar.producedByAgentId ? [{ label: 'Produced by', value: ar.producedByAgentId }] : []),
        ] },
      ];
      return { entity: { id: `artifact:${id}`, kind: 'artifact', label: ar.title }, sections,
        actions: [{ id: 'open_artifact_mission', kind: 'navigate', label: 'Open in Missions', href: '/missions' }, { id: 'promote_artifact', kind: 'api', label: 'Promote to G-Brain', method: 'POST', path: `/api/company-artifacts/${id}/promote-to-brain`, confirm: true }] };
    }
    case 'knowledge': {
      const k = getKnowledge(db, id);
      if (!k) throw new BrainError('knowledge not found', 404);
      const source = k.sourceId ? db.brainSources.get(k.sourceId) : null;
      const sections: InspectorSection[] = [
        { title: 'Overview', rows: [{ label: 'Kind', value: k.kind }, { label: 'Status', value: k.status }, ...(k.confidence != null ? [{ label: 'Confidence', value: String(k.confidence) }] : []), ...(k.summary ? [{ label: 'Summary', value: k.summary }] : [])] },
        { title: 'Provenance', rows: [
          ...(source ? [{ label: 'Source', value: `${source.type}${source.title ? ' · ' + source.title : ''}` }] : [{ label: 'Source', value: '(none)' }]),
          ...(source?.canonicalRef ? [{ label: 'From', value: `${source.canonicalRef.kind}:${source.canonicalRef.id}` }] : []),
          ...(k.createdByAgentId ? [{ label: 'Created by', value: k.createdByAgentId }] : []),
        ] },
      ];
      const actions: InspectorAction[] = [];
      if (source?.canonicalRef?.kind === 'artifact') actions.push({ id: 'open_artifact_mission', kind: 'navigate', label: 'Open source in Missions', href: '/missions' });
      if (k.status !== 'archived') actions.push({ id: 'archive_knowledge', kind: 'api', label: 'Archive knowledge', method: 'PATCH', path: `/api/brain/knowledge/${id}`, body: { status: 'archived' }, confirm: true });
      return { entity: { id: `knowledge:${id}`, kind: 'knowledge', label: k.title, status: k.status }, sections, actions };
    }
    case 'workflow': {
      const w = db.flowWorkflows.get(id);
      if (!w) throw new BrainError('workflow not found', 404);
      const sections: InspectorSection[] = [
        { title: 'Overview', rows: [{ label: 'Published', value: w.currentVersion != null ? `v${w.currentVersion}` : 'draft (unpublished)' }] },
      ];
      return { entity: { id: `workflow:${id}`, kind: 'workflow', label: w.name, status: w.currentVersion != null ? 'published' : 'draft' }, sections,
        actions: [{ id: 'open_flows', kind: 'navigate', label: 'Open in Flows', href: '/flows' }] };
    }
    case 'source': {
      const s = db.brainSources.get(id);
      if (!s) throw new BrainError('source not found', 404);
      const sections: InspectorSection[] = [
        { title: 'Overview', rows: [{ label: 'Type', value: s.type }, ...(s.uri ? [{ label: 'URI', value: s.uri }] : []), ...(s.canonicalRef ? [{ label: 'References', value: `${s.canonicalRef.kind}:${s.canonicalRef.id}` }] : [])] },
      ];
      const actions: InspectorAction[] = s.canonicalRef?.kind === 'artifact' ? [{ id: 'open_artifact_mission', kind: 'navigate', label: 'Open artifact in Missions', href: '/missions' }] : [];
      return { entity: { id: `source:${id}`, kind: 'source', label: s.title ?? s.type }, sections, actions };
    }
    case 'approval': {
      const ap = db.flowApprovals.get(id);
      if (!ap) throw new BrainError('approval not found', 404);
      const sections: InspectorSection[] = [
        { title: 'Overview', rows: [{ label: 'Status', value: ap.status }] }, // safe status only — never context_json
      ];
      return { entity: { id: `approval:${id}`, kind: 'approval', label: `Approval ${id.slice(0, 8)}`, status: ap.status }, sections,
        actions: [{ id: 'open_approvals', kind: 'navigate', label: 'Open in Approvals', href: '/approvals' }] };
    }
    case 'workflow_run': {
      const run = db.flowRuns.get(id);
      if (!run) throw new BrainError('workflow run not found', 404);
      const wf = db.flowWorkflows.get(run.workflowId);
      const sections: InspectorSection[] = [
        // safe fields only — NEVER startingInput, node outputs, tool args, or secrets
        { title: 'Overview', rows: [
          { label: 'Workflow', value: wf?.name ?? run.workflowId },
          { label: 'Version', value: `v${run.workflowVersion}` },
          { label: 'Status', value: run.status },
          ...(run.startedAt ? [{ label: 'Started', value: run.startedAt }] : []),
        ] },
      ];
      return { entity: { id: `workflow_run:${id}`, kind: 'workflow_run', label: `${wf?.name ?? 'workflow'} · run`, status: run.status }, sections,
        actions: [{ id: 'open_flows', kind: 'navigate', label: 'Open in Flows', href: '/flows' }] };
    }
    case 'event': {
      const ev = db.companyEvents.get(id);
      if (!ev) throw new BrainError('event not found', 404);
      const sections: InspectorSection[] = [
        // type + time + safe summary + linked refs only — never raw metadata blindly
        { title: 'Overview', rows: [{ label: 'Type', value: ev.type }, { label: 'When', value: ev.createdAt }, { label: 'Summary', value: ev.summary }] },
        { title: 'Links', rows: [
          ...(ev.missionId ? [{ label: 'Mission', value: ev.missionId }] : []),
          ...(ev.taskId ? [{ label: 'Task', value: ev.taskId }] : []),
          ...(ev.agentId ? [{ label: 'Agent', value: ev.agentId }] : []),
          ...(ev.artifactId ? [{ label: 'Artifact', value: ev.artifactId }] : []),
        ] },
      ];
      const actions: InspectorAction[] = ev.missionId ? [{ id: 'open_mission', kind: 'navigate', label: 'Open in Missions', href: '/missions' }] : [];
      return { entity: { id: `event:${id}`, kind: 'event', label: ev.type.replace(/_/g, ' ').toLowerCase() }, sections, actions };
    }
    default:
      throw new BrainError(`unknown inspector kind: ${input.kind}`, 400);
  }
}
