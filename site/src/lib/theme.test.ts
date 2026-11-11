import { describe, expect, test } from 'bun:test';
import { DEFAULT_THEME, type ResolvedTheme, resolveTheme, THEME_INIT_SCRIPT, type ThemeMode } from './theme';

const STORAGE_KEY = 'llama-webui-site-theme';

/** Runs the inline script against fake browser globals and returns the class it leaves on <html>. */
function runInitScript(options: { stored?: string | null; prefersDark?: boolean; storageThrows?: boolean }) {
  const html = { className: 'dark' };
  const storage = {
    getItem(key: string) {
      if (options.storageThrows) throw new Error('SecurityError');
      return key === STORAGE_KEY ? (options.stored ?? null) : null;
    },
  };
  const matchMedia = (query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' && (options.prefersDark ?? false),
  });
  new Function('document', 'localStorage', 'matchMedia', THEME_INIT_SCRIPT)(
    { documentElement: html },
    storage,
    matchMedia,
  );
  return html.className;
}

describe('resolveTheme', () => {
  const cases: [ThemeMode, boolean, ResolvedTheme][] = [
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['system', false, 'light'],
    ['system', true, 'dark'],
  ];
  test.each(cases)('%s with system dark = %p resolves to %s', (mode, prefersDark, expected) => {
    expect(resolveTheme(mode, prefersDark)).toBe(expected);
  });
});

describe('THEME_INIT_SCRIPT', () => {
  // The hydration render reads this class back: it has to be the one the store resolves afterwards.
  const modes: ThemeMode[] = ['dark', 'light', 'system'];
  for (const stored of modes) {
    for (const prefersDark of [false, true]) {
      test(`writes the resolved class for "${stored}" with system dark = ${prefersDark}`, () => {
        expect(runInitScript({ stored, prefersDark })).toBe(resolveTheme(stored, prefersDark));
      });
    }
  }

  test.each([false, true])(
    'falls back to the default mode when nothing is stored (system dark = %p)',
    (prefersDark) => {
      expect(runInitScript({ stored: null, prefersDark })).toBe(resolveTheme(DEFAULT_THEME, prefersDark));
    },
  );

  test.each([false, true])(
    'falls back to the default mode on an unknown stored value (system dark = %p)',
    (prefersDark) => {
      expect(runInitScript({ stored: 'bogus', prefersDark })).toBe(resolveTheme(DEFAULT_THEME, prefersDark));
    },
  );

  test.each([false, true])(
    'falls back to the default mode when localStorage throws (system dark = %p)',
    (prefersDark) => {
      expect(runInitScript({ storageThrows: true, prefersDark })).toBe(resolveTheme(DEFAULT_THEME, prefersDark));
    },
  );

  test('always leaves a non-empty class, so the attribute can be matched exactly', () => {
    expect(runInitScript({ stored: 'light' })).toBe('light');
  });
});
