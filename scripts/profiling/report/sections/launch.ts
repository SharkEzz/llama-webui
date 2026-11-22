import type { Section } from '../cell.ts';
import { tiles } from '../charts.ts';
import { pct } from '../format.ts';
import { section, windowsBlock } from './common.ts';

export const launch: Section = (results, cell) => {
  const s = results.scenarios.launch;
  if (!s) return null;
  return section(
    'launch',
    'Profile launch',
    'The profile started through the API with the Dashboard open, until llama-server answered as ready. Its GGUF files are evicted from the page cache first: the start reads them from the disk.',
    `${tiles([
      { label: 'start to ready', value: cell('launch.readyMs') },
      { label: 'log lines during the start', value: cell('launch.logLines') },
      {
        label: 'model in the page cache at the start',
        value: s.modelCachedPct === undefined || s.modelCachedPct === null ? 'unknown' : pct(s.modelCachedPct),
      },
    ])}
${windowsBlock('launch', s.windows, cell)}`,
  );
};
