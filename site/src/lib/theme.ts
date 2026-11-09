import { useSyncExternalStore } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'llama-webui-site-theme';
/** The site is dark by default (tech look); prerendered HTML ships with class="dark". */
export const DEFAULT_THEME: ThemeMode = 'dark';

/**
 * Inline script run in <head> before first paint: applies the stored mode so there is no light/dark flash.
 * Kept as a string (no imports) because it is injected verbatim by root.tsx.
 */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement;try{var m=localStorage.getItem('${STORAGE_KEY}')||'${DEFAULT_THEME}';var dark=m==='dark'||(m==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);d.classList.toggle('dark',dark);}catch(e){d.classList.add('dark');}})();`;

const listeners = new Set<() => void>();

function readMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(mode: ThemeMode) {
  const dark = mode === 'dark' || (mode === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

export function setThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // private mode: the choice just isn't remembered
  }
  apply(mode);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = () => {
    if (readMode() === 'system') apply('system');
    listener();
  };
  media.addEventListener('change', onSystemChange);
  return () => {
    listeners.delete(listener);
    media.removeEventListener('change', onSystemChange);
  };
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, readMode, () => DEFAULT_THEME);
}
