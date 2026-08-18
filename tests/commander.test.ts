/**
 * IGRIS Commander (U2) logic — lane classification, slash resolution, GO search,
 * context grounding, honest missing-context handling, and DO recognition-only.
 * All pure: no I/O, no execution. Safety-critical: DO never runs; ASK context is
 * identifiers only.
 */
import { describe, expect, test } from 'vitest';
import {
  classifyInput,
  goHits,
  describeContext,
  buildAskContext,
  unresolvedReferences,
  recognizeDoAction,
  isCommanderToggle,
  navToCommands,
  mergeCommands,
  SLASH_ROUTES,
} from '@/lib/commander';
import { NAV_OPERATE, NAV_AGENTS, NAV_INTELLIGENCE, NAV_SYSTEM, NAV_LIBRARY } from '@/lib/nav';
import type { IgrisContextEnvelope } from '@/lib/context-envelope';
import type { Command } from '@/lib/palette';

const ALL_NAV = navToCommands([...NAV_OPERATE, ...NAV_AGENTS, ...NAV_INTELLIGENCE, ...NAV_SYSTEM, ...NAV_LIBRARY]);

const COMMANDS: Command[] = [
  { id: 'nav-approvals', label: 'Approvals', keywords: 'approve pending human gate', href: '/approvals', hint: 'view' },
  { id: 'nav-flows', label: 'Flows', keywords: 'workflow orchestrator', href: '/flows', hint: 'view' },
  { id: 'nav-agents', label: 'Agents', keywords: 'roster runtime', href: '/agents', hint: 'view' },
  { id: 'agent-gmail', label: 'Gmail Worker', keywords: 'email agent', href: '/agents', hint: 'agent' },
];

const env = (patch: Partial<IgrisContextEnvelope> = {}): IgrisContextEnvelope => ({
  route: '/', surface: 'home', updatedAt: 1, ...patch,
});

describe('lane classification', () => {
  test('GO — navigation / plain search', () => {
    expect(classifyInput('open approvals')).toMatchObject({ lane: 'go', query: 'approvals' });
    expect(classifyInput('Gmail Worker')).toMatchObject({ lane: 'go', query: 'Gmail Worker' });
    expect(classifyInput('go to flows')).toMatchObject({ lane: 'go', query: 'flows' });
  });

  test('ASK — questions', () => {
    expect(classifyInput('Why did this run fail?')).toMatchObject({ lane: 'ask' });
    expect(classifyInput('what am I looking at')).toMatchObject({ lane: 'ask' });
    expect(classifyInput('explain this node')).toMatchObject({ lane: 'ask' });
    expect(classifyInput('is Gmail Worker connected?')).toMatchObject({ lane: 'ask' });
  });

  test('DO — action verbs (recognized, not executed)', () => {
    expect(classifyInput('run this workflow')).toMatchObject({ lane: 'do' });
    expect(classifyInput('delete this workflow')).toMatchObject({ lane: 'do' });
    expect(classifyInput('switch this agent to hermes serve')).toMatchObject({ lane: 'do' });
    expect(classifyInput('approve this')).toMatchObject({ lane: 'do' });
  });

  test('slash commands resolve to routes or /ask', () => {
    expect(classifyInput('/flows')).toMatchObject({ lane: 'go', slashHref: '/flows' });
    expect(classifyInput('/approvals')).toMatchObject({ lane: 'go', slashHref: '/approvals' });
    expect(classifyInput('/ask why did it fail')).toMatchObject({ lane: 'ask', query: 'why did it fail' });
    expect(SLASH_ROUTES.brain).toBe('/brain');
  });

  test('unknown slash is treated as GO search, not an action', () => {
    expect(classifyInput('/run').lane).toBe('go'); // NOT do — U2 never wires /run to execution
  });

  test('forced lane overrides classification (user correction)', () => {
    expect(classifyInput('approvals', 'ask')).toMatchObject({ lane: 'ask', forced: true });
    expect(classifyInput('why did this fail?', 'go')).toMatchObject({ lane: 'go', forced: true });
  });
});

describe('GO resolution', () => {
  test('goHits ranks the matching destination first', () => {
    const hits = goHits(COMMANDS, classifyInput('open approvals'));
    expect(hits[0]?.href).toBe('/approvals');
  });
  test('slash-nav yields no list (navigates directly)', () => {
    expect(goHits(COMMANDS, classifyInput('/flows'))).toEqual([]);
  });
  test('empty query returns all commands (browse)', () => {
    expect(goHits(COMMANDS, classifyInput('')).length).toBe(COMMANDS.length);
  });

  test('GO reaches every canonical page via nav-derived commands', () => {
    const top = (q: string) => goHits(ALL_NAV, classifyInput(q))[0]?.href;
    expect(top('open approvals')).toBe('/approvals');
    expect(top('open flows')).toBe('/flows');
    expect(top('open models')).toBe('/models');
    expect(top('open agents')).toBe('/agents');
    expect(top('g-brain')).toBe('/brain');
    expect(top('skills')).toBe('/skills');
    expect(top('tasks')).toBe('/tasks');
    expect(top('settings')).toBe('/settings');
  });

  test('navToCommands + mergeCommands de-duplicate by href (primary wins)', () => {
    const nav = navToCommands(NAV_INTELLIGENCE);
    expect(nav.find((c) => c.href === '/approvals')?.label).toBe('Approvals');
    const merged = mergeCommands(nav, [{ id: 'x', label: 'Dupe Flows', keywords: '', href: '/flows' }]);
    expect(merged.filter((c) => c.href === '/flows')).toHaveLength(1);
    expect(merged.find((c) => c.href === '/flows')?.label).toBe('Flows'); // primary kept
  });
});

describe('context grounding', () => {
  test('describeContext renders a readable breadcrumb', () => {
    expect(describeContext(env({ surface: 'flows', workflowId: 'wf-main', selectedNodeId: 'n1' }))).toBe('Flows › wf-main › node n1');
    expect(describeContext(env({ surface: 'approvals', approvalId: 'ap1' }))).toBe('Approvals › approval ap1');
    expect(describeContext(env())).toBe('Home');
  });

  test('buildAskContext contains identifiers only — no secrets/graph/payload', () => {
    const ctx = buildAskContext(env({ surface: 'flows', workflowId: 'wf-main', workflowVersion: 3, selectedNodeId: 'n1', runId: 'r9' }));
    expect(ctx).toContain('workflowId: wf-main');
    expect(ctx).toContain('runId: r9');
    for (const banned of ['token', 'secret', 'apiKey', 'authorization', 'graph', 'nodes', 'prompt', 'output', 'password', 'context_json']) {
      expect(ctx.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});

describe('honest missing-context handling', () => {
  test('references to unselected context are reported, not guessed', () => {
    expect(unresolvedReferences(env({ surface: 'flows' }), 'explain this node')).toEqual(['this node']);
    expect(unresolvedReferences(env({ surface: 'flows', selectedNodeId: 'n1' }), 'explain this node')).toEqual([]);
    expect(unresolvedReferences(env(), 'why did this run fail?')).toEqual(['this run']);
  });
});

describe('DO recognition is inert', () => {
  test('recognizeDoAction proposes but requires preview (no execution)', () => {
    const p = recognizeDoAction('run this workflow');
    expect(p.verb).toBe('run');
    expect(p.requiresPreview).toBe(true);
    expect(p.summary).toContain('run this workflow');
  });
});

describe('keyboard toggle', () => {
  test('isCommanderToggle matches Ctrl/Cmd+K only', () => {
    expect(isCommanderToggle({ key: 'k', metaKey: true })).toBe(true);
    expect(isCommanderToggle({ key: 'K', ctrlKey: true })).toBe(true);
    expect(isCommanderToggle({ key: 'k' })).toBe(false);
    expect(isCommanderToggle({ key: 'j', metaKey: true })).toBe(false);
  });
});
