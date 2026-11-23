// A comparison in Markdown, short enough for a pull request comment: the figures outside the noise, what failed on
// either side and the comparison's notes. It names versions, scenarios and figures, nothing of the machine; only a
// failed scenario's message may hold a path.
import type { Comparison } from './compare.ts';
import { figures } from './figures.ts';
import { delta, num, value } from './report/format.ts';
import type { Results } from './results.ts';

/** The most figures a summary lists: a comment stays readable, and far under GitHub's size limit. */
export const SUMMARY_ROWS = 40;

/** A table cell: one line, no column break. */
const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll(/\s+/g, ' ').trim();

const plural = (n: number, one: string, many: string): string => `${num(n)} ${n === 1 ? one : many}`;

function relative(r: number | null): string {
  if (r === null) return '';
  const pct = Math.round(Math.abs(r) * 100);
  return ` (${r < 0 ? '−' : '+'}${num(pct)}%)`;
}

export function summary(results: Results, reference: Results, comparison: Comparison, rows = SUMMARY_ROWS): string {
  const version = (r: Results) => `\`${r.run.versions.app}\``;
  const lines = [`## Profiling: ${version(results)} against ${version(reference)}`, ''];
  const facts = [`Scenarios: ${results.run.scenarios.map((s) => `\`${s}\``).join(', ') || 'none'}`];
  if (results.run.profile !== null) facts.push(`profile #${String(results.run.profile.id)}`);
  if (results.run.gpuCompositing !== null && results.run.gpuCompositing !== 'enabled')
    facts.push(`**Chromium composited in software (${results.run.gpuCompositing}): page and GPU figures overstate**`);
  lines.push(`${facts.join(' · ')}.`, '');

  const compared = comparison.byId.size;
  const changed = comparison.changed;
  if (compared === 0) lines.push('No figure could be compared: the two sides share no scenario that ran.');
  else if (changed.length === 0)
    lines.push(
      `None of the ${plural(compared, 'compared figure is', 'compared figures are')} outside its noise threshold.`,
    );
  else {
    lines.push(
      `**${num(changed.length)} of ${plural(compared, 'compared figure', 'compared figures')} outside the noise thresholds**, the largest excess first.`,
      '',
      '| Scenario | Figure | Base | Head | Difference |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const f of changed.slice(0, rows)) {
      const d = comparison.byId.get(f.id);
      if (d === undefined) continue;
      lines.push(
        `| ${f.scenario} | ${cell(f.label)} | ${value(d.reference, f.kind)} | ${value(f.value, f.kind)} | ${delta(d.delta, f.kind)}${relative(d.relative)} |`,
      );
    }
    if (changed.length > rows) lines.push('', `${num(changed.length - rows)} more in the report.`);
  }

  const failed = [
    ...reference.failed.map((f) => ({ ...f, side: 'base' })),
    ...results.failed.map((f) => ({ ...f, side: 'head' })),
  ];
  if (failed.length > 0) {
    lines.push('', '### Failed', '');
    for (const f of failed) lines.push(`- \`${f.scenario}\` on the ${f.side}: ${cell(f.error)}`);
  }
  if (comparison.notes.length > 0) {
    lines.push('', '### Notes', '');
    for (const n of comparison.notes) lines.push(`- \`${n.scenario}\`: ${cell(n.note)}`);
  }
  // Every figure of the run that the base does not have is shown without comparison: say how many, not which.
  const alone = figures(results).length - compared;
  if (alone > 0 && compared > 0)
    lines.push(
      '',
      `${plural(alone, 'figure has', 'figures have')} no counterpart on the base and ${alone === 1 ? 'is' : 'are'} not compared.`,
    );
  return `${lines.join('\n')}\n`;
}
