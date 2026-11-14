import type { ThemeMode } from '@llama-webui/shared';
import { create } from 'zustand';
import { call } from './api';

const KEY = 'llama-webui:theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function stored(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

const resolve = (mode: ThemeMode): 'light' | 'dark' => (mode === 'system' ? (media.matches ? 'dark' : 'light') : mode);

function apply(mode: ThemeMode): 'light' | 'dark' {
  const resolved = resolve(mode);
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  try {
    localStorage.setItem(KEY, mode);
  } catch {}
  return resolved;
}

interface ThemeState {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  /** Applies the theme and stores it in the browser and the database. */
  setMode(mode: ThemeMode): void;
}

export const useTheme = create<ThemeState>((set) => {
  const mode = stored();
  return {
    mode,
    resolved: resolve(mode),
    setMode(next) {
      set({ mode: next, resolved: apply(next) });
      call((api) => api.settings.patch({ payload: { theme: next } })).catch(() => {});
    },
  };
});

/** Follows prefers-color-scheme in System mode; the database wins at startup (choice made from another browser). */
export function startThemeSync() {
  media.addEventListener('change', () => {
    const { mode } = useTheme.getState();
    if (mode === 'system') useTheme.setState({ resolved: apply('system') });
  });
  call((api) => api.settings.get())
    .then((s) => {
      if (s.theme !== useTheme.getState().mode) useTheme.setState({ mode: s.theme, resolved: apply(s.theme) });
    })
    .catch(() => {});
}
