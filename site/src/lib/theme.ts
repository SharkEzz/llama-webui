import { useSyncExternalStore } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
/** What a mode comes down to once the system preference is known: the class carried by <html>. */
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'llama-webui-site-theme';
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';
/** The site is dark by default (tech look); prerendered HTML ships with class="dark". */
export const DEFAULT_THEME: ThemeMode = 'dark';
/** Class of <html> in the prerendered pages, where neither the stored mode nor the system preference is known. */
const PRERENDERED_THEME: ResolvedTheme = 'dark';

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  return mode === 'dark' || (mode === 'system' && prefersDark) ? 'dark' : 'light';
}

/**
 * Inline script run in <head> before first paint: writes the resolved theme as the class of <html>, so there is no
 * light/dark flash. Same logic as readMode() + resolveTheme(): the hydration render reads this class back
 * (readHydratedTheme) and the store must then resolve to the same value.
 * Kept as a string (no imports) because it is injected verbatim by root.tsx.
 */
export const THEME_INIT_SCRIPT = `(function(){var m;try{m=localStorage.getItem('${STORAGE_KEY}');}catch(e){}if(m!=='light'&&m!=='dark'&&m!=='system')m='${DEFAULT_THEME}';var dark=m==='dark'||(m==='system'&&matchMedia('${SYSTEM_DARK_QUERY}').matches);document.documentElement.className=dark?'dark':'light';})();`;

const listeners = new Set<() => void>();

function readMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function readResolvedTheme(): ResolvedTheme {
  return resolveTheme(readMode(), window.matchMedia(SYSTEM_DARK_QUERY).matches);
}

/**
 * Snapshot used for the prerender and for the hydration render. In the browser it is the class the inline script
 * left on <html>, so that render matches the DOM whatever the stored mode is.
 */
function readHydratedTheme(): ResolvedTheme {
  if (typeof document === 'undefined') return PRERENDERED_THEME;
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function setThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // private mode: the choice just isn't remembered
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = window.matchMedia(SYSTEM_DARK_QUERY);
  media.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    media.removeEventListener('change', listener);
  };
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, readMode, () => DEFAULT_THEME);
}

/** Theme to render as the class of <html> (root.tsx): React owns that class once hydrated. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, readResolvedTheme, readHydratedTheme);
}
