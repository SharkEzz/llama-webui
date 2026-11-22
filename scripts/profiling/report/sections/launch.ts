import type { Section } from '../cell.ts';
import { tiles } from '../charts.ts';
import { section, windowsBlock } from './common.ts';

export const launch: Section = (results, cell) => {
  const s = results.scenarios.launch;
  if (!s) return null;
  return section(
    'launch',
    'Profile launch',
    'The profile started through the API with the Dashboard open, until llama-server answered as ready.',
    `${tiles([
      { label: 'start to ready', value: cell('launch.readyMs') },
      { label: 'log lines during the start', value: cell('launch.logLines') },
    ])}
${windowsBlock('launch', s.windows, cell)}`,
  );
};
