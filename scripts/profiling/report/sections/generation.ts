import type { Section } from '../cell.ts';
import { section, windowsBlock } from './common.ts';

export const generation: Section = (results, cell) => {
  const s = results.scenarios.generation;
  if (!s) return null;
  return section(
    'generation',
    'Dashboard during a generation',
    "The Dashboard open while a reply is generated through the app's chat API (in a temporary conversation).",
    windowsBlock('generation', s.windows, cell),
  );
};
