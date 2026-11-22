import { windowsOf } from '../../figures.ts';
import { SCENARIO_NAMES } from '../../results.ts';
import type { Section } from '../cell.ts';
import { details, stacked, table } from '../charts.ts';
import { esc, pct } from '../format.ts';
import { groupLabel, MAIN_GROUPS, section } from './common.ts';

export const overview: Section = (results, cell) => {
  const windows = SCENARIO_NAMES.flatMap((scenario) =>
    windowsOf(results, scenario)
      .filter((w) => !w.profiled)
      .map((w) => ({ scenario, w })),
  );
  if (windows.length === 0) return null;
  const id = (scenario: string, wid: string, g: string) => `${scenario}.${wid}.cpu.${g}`;
  const rows = windows.map(({ scenario, w }) => {
    const parts = MAIN_GROUPS.map((g) => cell.value(id(scenario, w.id, g)) ?? 0);
    return { label: `${scenario}: ${w.label}`, parts, total: pct(parts.reduce((a, b) => a + b, 0)) };
  });
  return section(
    'overview',
    'Overview',
    'CPU of each process in % of one core, one row per window measured without a profiler.',
    `<figure>${stacked(rows, MAIN_GROUPS.map(groupLabel), {
      title: 'CPU by process and by window, % of one core',
      format: (v) => pct(v),
    })}</figure>
${details(
  'The same figures as a table',
  table(
    ['Window', ...MAIN_GROUPS.map(groupLabel)],
    windows.map(({ scenario, w }) =>
      [esc(`${scenario}: ${w.label}`)].concat(MAIN_GROUPS.map((g) => cell(id(scenario, w.id, g)))),
    ),
    [1, 2, 3, 4],
  ),
)}`,
  );
};
