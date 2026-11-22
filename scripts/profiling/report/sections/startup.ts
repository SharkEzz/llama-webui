import type { Section } from '../cell.ts';
import { table, tiles } from '../charts.ts';
import { ms, num } from '../format.ts';
import { profileBlock, section } from './common.ts';

export const startup: Section = (results, cell) => {
  const s = results.scenarios.startup;
  if (!s) return null;
  const launches = s.startMs.map((start, i) => [
    num(i + 1),
    ms(start),
    s.stopMs[i] === undefined ? '—' : ms(s.stopMs[i]),
    s.bareNodeMs[i] === undefined ? '—' : ms(s.bareNodeMs[i]),
  ]);
  return section(
    'startup',
    'Startup and shutdown',
    'The production build started on a free port with an empty data directory, timed from spawn to the first answer of <code>/api/health</code>, then from SIGTERM to its exit; bare Node is the same spawn of an empty script.',
    `${tiles([
      { label: 'start to /api/health (median)', value: cell('startup.startMs') },
      { label: 'SIGTERM to exit (median)', value: cell('startup.stopMs') },
      { label: 'bare Node start (median)', value: cell('startup.bareNodeMs') },
    ])}
${table(['Launch', 'Start', 'Stop', 'Bare Node'], launches, [1, 2, 3])}
${profileBlock('CPU profile of a launch', s.launchProfile, cell('startup.profile.activeMs'))}`,
  );
};
