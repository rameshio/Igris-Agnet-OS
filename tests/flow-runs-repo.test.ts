import { describe, expect, test } from 'vitest';
import { openDb } from '@/lib/db';

describe('flow_runs + flow_node_runs repos (execution history)', () => {
  test('create run → update status → finish, with version reference', () => {
    const db = openDb(':memory:');
    const run = db.flowRuns.create({ id: 'r1', workflowId: 'wf-x', workflowVersion: 3, startingInput: { text: 'go' } });
    expect(run.status).toBe('queued');
    expect(run.workflowVersion).toBe(3);
    expect(run.startingInput.text).toBe('go');

    db.flowRuns.update('r1', { status: 'running', startedAt: '2026-01-01T00:00:00Z' });
    db.flowRuns.update('r1', { status: 'success', endedAt: '2026-01-01T00:00:10Z', totalTokens: 42, estimatedCost: null });
    const done = db.flowRuns.get('r1')!;
    expect(done.status).toBe('success');
    expect(done.totalTokens).toBe(42);
    expect(done.estimatedCost).toBeNull();
  });

  test('node run round-trips JSON output + model metadata + nullable usage/cost', () => {
    const db = openDb(':memory:');
    db.flowRuns.create({ id: 'r2', workflowId: 'wf', workflowVersion: 1, startingInput: { text: '' } });
    db.flowNodeRuns.create({ id: 'nr1', runId: 'r2', nodeId: 'a', nodeType: 'agent', status: 'queued' });
    db.flowNodeRuns.update('nr1', {
      status: 'success',
      input: { text: 'in', data: { upstream: [] } },
      output: { text: 'out', data: { score: 82 } },
      providerId: 'nvidia',
      modelId: 'nemotron',
      modelStrategy: 'fixed',
      adapter: 'openai-compatible',
      promptTokens: 3,
      completionTokens: 5,
      totalTokens: 8,
      estimatedCost: null,
      durationMs: 1200,
    });
    const nr = db.flowNodeRuns.get('nr1')!;
    expect(nr.output).toEqual({ text: 'out', data: { score: 82 } });
    expect((nr.input as { text: string }).text).toBe('in');
    expect(nr.providerId).toBe('nvidia');
    expect(nr.totalTokens).toBe(8);
    expect(nr.estimatedCost).toBeNull();
  });

  test('forRun returns nodes; recentForWorkflow lists runs newest-first', () => {
    const db = openDb(':memory:');
    db.flowRuns.create({ id: 'ra', workflowId: 'wf', workflowVersion: 1, startingInput: { text: '' } });
    db.flowRuns.create({ id: 'rb', workflowId: 'wf', workflowVersion: 1, startingInput: { text: '' } });
    db.flowNodeRuns.create({ id: 'x', runId: 'ra', nodeId: 'n1', nodeType: 'input', status: 'success' });
    db.flowNodeRuns.create({ id: 'y', runId: 'ra', nodeId: 'n2', nodeType: 'output', status: 'success' });
    expect(db.flowNodeRuns.forRun('ra')).toHaveLength(2);
    const recent = db.flowRuns.recentForWorkflow('wf');
    expect(recent.map((r) => r.id)).toContain('ra');
    expect(recent.map((r) => r.id)).toContain('rb');
  });

  test('safe error round-trips (no secret columns exist)', () => {
    const db = openDb(':memory:');
    db.flowRuns.create({ id: 'r3', workflowId: 'wf', workflowVersion: 1, startingInput: { text: '' } });
    db.flowNodeRuns.create({ id: 'e1', runId: 'r3', nodeId: 'a', nodeType: 'agent', status: 'queued' });
    db.flowNodeRuns.update('e1', { status: 'failed', errorCode: 'credential_missing', errorMessage: 'NVIDIA has no API key configured.' });
    const nr = db.flowNodeRuns.get('e1')!;
    expect(nr.errorCode).toBe('credential_missing');
    expect(Object.keys(nr)).not.toContain('apiKey');
  });
});
