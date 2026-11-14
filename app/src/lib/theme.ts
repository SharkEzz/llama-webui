import type { ThemeMode } from '@llama-webui/shared';
import { create } from 'zustand';

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
  /** Applies the theme and stores it in the browser. */
  setMode(mode: ThemeMode): void;
}

export const useTheme = create<ThemeState>((set) => {
  const mode = stored();
  return {
    mode,
    resolved: resolve(mode),
    setMode(next) {
      set({ mode: next, resolved: apply(next) });
    },
  };
});

/** Follows prefers-color-scheme in System mode. A browser preference until the settings are ported (E1, Task 7). */
export function startThemeSync() {
  media.addEventListener('change', () => {
    const { mode } = useTheme.getState();
    if (mode === 'system') useTheme.setState({ resolved: apply('system') });
  });
}
