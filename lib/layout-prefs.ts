/**
 * App-shell layout preferences (presentation only). Currently: the main
 * navigation sidebar collapse. Persisted in localStorage and applied to the
 * `--nav-w` CSS variable + a `data-nav` attribute on <html> BEFORE first paint
 * (via NAV_INIT_SCRIPT), mirroring the theme system so there is no layout flash.
 *
 * Pure + framework-free so the parsing/width logic is unit-testable. No DB, no
 * secrets — these are non-sensitive display preferences only.
 */
export const NAV_W_EXPANDED = 232;
export const NAV_W_COLLAPSED = 64;

/** localStorage keys for the persisted collapse preferences. */
export const NAV_COLLAPSE_KEY = 'igris-nav-collapsed';
export const FLOWS_LIST_COLLAPSE_KEY = 'igris-flows-list-collapsed';
/** Activity/Ops dock (U4): remembers whether the right-side stream is open. */
export const ACTIVITY_OPEN_KEY = 'igris-activity-open';

/** Width of the Activity dock when open (0 when collapsed → main surface grows). */
export const ACTIVITY_W = 340;

/** Parse a stored on/off preference; unknown/absent values fall back. */
export function parseBoolPref(raw: string | null, fallback = false): boolean {
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return fallback;
}

/** Serialize a boolean preference the way the init script reads it. */
export function serializeBoolPref(value: boolean): string {
  return value ? '1' : '0';
}

/** Sidebar width in px for a given collapsed state. */
export function navWidth(collapsed: boolean): number {
  return collapsed ? NAV_W_COLLAPSED : NAV_W_EXPANDED;
}

/**
 * Inline-able script (string) that applies the persisted nav width + data-nav
 * before first paint, so the content column starts at the right offset with no
 * flash. Injected in <head> via the root layout, like THEME_INIT_SCRIPT.
 */
export const NAV_INIT_SCRIPT = `(function(){try{var c=localStorage.getItem('${NAV_COLLAPSE_KEY}')==='1';var r=document.documentElement;r.style.setProperty('--nav-w',(c?${NAV_W_COLLAPSED}:${NAV_W_EXPANDED})+'px');r.setAttribute('data-nav',c?'collapsed':'expanded');}catch(e){document.documentElement.style.setProperty('--nav-w','${NAV_W_EXPANDED}px');}})();`;
