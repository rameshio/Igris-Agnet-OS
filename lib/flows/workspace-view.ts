/**
 * Presentation-only view state for the /flows workspace: which side panels are
 * collapsed and whether Focus Canvas is active. Pure + framework-free so the
 * toggle logic is unit-testable and provably NEVER touches graph/version/run
 * data — collapsing panels or entering focus is display state only.
 */
export type WorkspaceView = {
  /** Main app navigation sidebar collapsed to icons. */
  navCollapsed: boolean;
  /** /flows workflow list collapsed to a reopen tab. */
  listCollapsed: boolean;
  /** Focus Canvas: the canvas takes over the viewport (app focus, not OS fullscreen). */
  focus: boolean;
};

export function makeView(partial?: Partial<WorkspaceView>): WorkspaceView {
  return { navCollapsed: false, listCollapsed: false, focus: false, ...partial };
}

export function toggleNav(v: WorkspaceView): WorkspaceView {
  return { ...v, navCollapsed: !v.navCollapsed };
}
export function toggleList(v: WorkspaceView): WorkspaceView {
  return { ...v, listCollapsed: !v.listCollapsed };
}
export function enterFocus(v: WorkspaceView): WorkspaceView {
  return { ...v, focus: true };
}
export function exitFocus(v: WorkspaceView): WorkspaceView {
  return { ...v, focus: false };
}

/**
 * Which panels are actually visible. In Focus Canvas the nav + list are hidden,
 * but their collapse preferences are PRESERVED (focus is orthogonal), so exiting
 * focus restores the prior layout exactly.
 */
export function panelsVisible(v: WorkspaceView): { nav: boolean; list: boolean } {
  return { nav: !v.focus && !v.navCollapsed, list: !v.focus && !v.listCollapsed };
}
