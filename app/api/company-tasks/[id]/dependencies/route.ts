/**
 * Task dependencies (Architecture V2 · F0.2).
 *   GET    /api/company-tasks/:id/dependencies                      — prerequisites + satisfied flag
 *   POST   /api/company-tasks/:id/dependencies { dependsOnTaskId }  — add (same-mission, acyclic)
 *   DELETE /api/company-tasks/:id/dependencies?dependsOnTaskId=…    — remove
 *
 * Storing a dependency NEVER auto-starts a task — F0.2 only records and reports it.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/data';
import { addTaskDependency, removeTaskDependency, getTaskDependencies, companyErrorInfo } from '@/lib/company/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({ dependsOnTaskId: z.string().min(1) });

export function GET(_req: Request, { params }: { params: { id: string } }) {
  const { dependsOn, satisfied } = getTaskDependencies(getDb(), params.id);
  return NextResponse.json({ taskId: params.id, dependsOn, prerequisitesSatisfied: satisfied });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const parsed = Body.parse(await req.json().catch(() => ({})));
    addTaskDependency(getDb(), params.id, parsed.dependsOnTaskId);
    const { dependsOn, satisfied } = getTaskDependencies(getDb(), params.id);
    return NextResponse.json({ ok: true, dependsOn, prerequisitesSatisfied: satisfied });
  } catch (err) {
    const { status, error } = companyErrorInfo(err);
    return NextResponse.json({ error }, { status });
  }
}

export function DELETE(req: Request, { params }: { params: { id: string } }) {
  const dependsOnTaskId = new URL(req.url).searchParams.get('dependsOnTaskId');
  if (!dependsOnTaskId) return NextResponse.json({ error: 'dependsOnTaskId required' }, { status: 400 });
  removeTaskDependency(getDb(), params.id, dependsOnTaskId);
  return NextResponse.json({ ok: true });
}
