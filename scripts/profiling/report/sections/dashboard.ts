import type { Section } from '../cell.ts';
import { section, windowsBlock } from './common.ts';

export const dashboard: Section = (results, cell) => {
  const s = results.scenarios.dashboard;
  if (!s) return null;
  return section(
    'dashboard',
    'Dashboard at rest',
    'The Dashboard open with the model loaded and nothing generating: a clean window, a window under the server and page profilers with the census of rendered components, and a trace.',
    windowsBlock('dashboard', s.windows, cell),
  );
};
