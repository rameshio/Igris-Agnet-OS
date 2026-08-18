/**
 * /flows workspace view-state (collapsible workspace UX). Pure presentation
 * logic: toggling panels or entering/exiting Focus Canvas must never mutate
 * graph/version/run data, and exiting focus must restore the prior layout.
 */
import { describe, expect, test } from 'vitest';
import {
  makeView,
  toggleNav,
  toggleList,
  enterFocus,
  exitFocus,
  panelsVisible,
  type WorkspaceView,
} from '@/lib/flows/workspace-view';
import { parseBoolPref, serializeBoolPref, navWidth, NAV_W_EXPANDED, NAV_W_COLLAPSED } from '@/lib/layout-prefs';

describe('workspace view toggles', () => {
  test('toggle main sidebar flips only navCollapsed', () => {
    const v = makeView();
    const a = toggleNav(v);
    expect(a.navCollapsed).toBe(true);
    expect(a.listCollapsed).toBe(false);
    expect(a.focus).toBe(false);
    expect(toggleNav(a).navCollapsed).toBe(false);
  });

  test('toggle workflow list flips only listCollapsed', () => {
    const a = toggleList(makeView());
    expect(a.listCollapsed).toBe(true);
    expect(a.navCollapsed).toBe(false);
  });

  test('enter/exit focus flips only focus', () => {
    const a = enterFocus(makeView());
    expect(a.focus).toBe(true);
    expect(exitFocus(a).focus).toBe(false);
  });

  test('exiting focus RESTORES the prior collapse layout exactly', () => {
    const start: WorkspaceView = makeView({ navCollapsed: true, listCollapsed: false });
    const restored = exitFocus(enterFocus(start));
    expect(restored).toEqual(start); // nav/list prefs preserved across focus
  });

  test('panelsVisible hides nav+list in focus but keeps prefs intact', () => {
    const v = makeView({ navCollapsed: false, listCollapsed: false, focus: true });
    expect(panelsVisible(v)).toEqual({ nav: false, list: false });
    // Same prefs, focus off → both visible.
    expect(panelsVisible({ ...v, focus: false })).toEqual({ nav: true, list: true });
    // Collapsed prefs honored when not in focus.
    expect(panelsVisible(makeView({ navCollapsed: true }))).toEqual({ nav: false, list: true });
  });

  test('toggles are immutable — the input view object is never mutated', () => {
    const v = makeView();
    toggleNav(v);
    toggleList(v);
    enterFocus(v);
    expect(v).toEqual({ navCollapsed: false, listCollapsed: false, focus: false });
  });

  test('view state carries NO graph/version/run fields (presentation only)', () => {
    expect(Object.keys(makeView()).sort()).toEqual(['focus', 'listCollapsed', 'navCollapsed']);
  });
});

describe('layout preference persistence helpers', () => {
  test('parseBoolPref reads stored values and falls back on garbage/absent', () => {
    expect(parseBoolPref('1')).toBe(true);
    expect(parseBoolPref('true')).toBe(true);
    expect(parseBoolPref('0')).toBe(false);
    expect(parseBoolPref('false')).toBe(false);
    expect(parseBoolPref(null)).toBe(false);
    expect(parseBoolPref('garbage', true)).toBe(true);
    expect(parseBoolPref(null, true)).toBe(true);
  });

  test('serialize/parse round-trips', () => {
    expect(parseBoolPref(serializeBoolPref(true))).toBe(true);
    expect(parseBoolPref(serializeBoolPref(false))).toBe(false);
  });

  test('navWidth maps collapse state to the sidebar width', () => {
    expect(navWidth(false)).toBe(NAV_W_EXPANDED);
    expect(navWidth(true)).toBe(NAV_W_COLLAPSED);
  });
});
