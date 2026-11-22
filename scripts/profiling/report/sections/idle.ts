import type { Section } from '../cell.ts';
import { section, windowsBlock } from './common.ts';

export const idle: Section = (results, cell) => {
  const s = results.scenarios.idle;
  if (!s) return null;
  return section(
    'idle',
    'Server at rest, no page',
    'The server and its NVML sampler with no page open and no model loaded: what the app costs when nobody looks at it.',
    windowsBlock('idle', s.windows, cell),
  );
};
