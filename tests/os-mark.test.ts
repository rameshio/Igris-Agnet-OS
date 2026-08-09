import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Branding (2026-08-03): the OS mark is the CHROME yin-yang emblem from the
 * Founder OS brand assets (public/os-emblem.png, chrome on transparent).
 * Supersedes the 2026-07-13 red ring-with-S SVG.
 *
 * Update (2026-08-04): the emblem IS the browser-tab favicon (app/icon.png,
 * derived from the same asset) and no longer sits in the sidebar lockup —
 * wordmark only there. The topbar keeps the mark.
 */
describe('OS mark branding', () => {
  test('the mark renders the chrome emblem asset, not an inked SVG', () => {
    const mark = read('components/OsMark.tsx');
    expect(mark).toContain('/os-emblem.png');
    // chrome emblem: no brand-red ink, no drawn ring/seam left behind
    expect(mark).not.toContain('#ef4444');
    expect(mark).not.toContain('<path');
    // the asset itself ships with the app
    expect(existsSync(join(process.cwd(), 'public/os-emblem.png'))).toBe(true);
  });

  test('the emblem is the favicon; the old OS-lettered svg is gone', () => {
    expect(existsSync(join(process.cwd(), 'app/icon.png'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'app/icon.svg'))).toBe(false);
  });

  test('the sidebar is wordmark-only', () => {
    const sidebar = read('components/Sidebar.tsx');
    expect(sidebar).not.toContain('OsMark');
    expect(sidebar).toContain('IGRIS AGENT');
    // the mark renders no text at all
    expect(read('components/OsMark.tsx')).not.toMatch(/<text/);
  });

  test('the topbar carries the emblem', () => {
    expect(read('components/Topbar.tsx')).toContain('OsMark');
  });
});
