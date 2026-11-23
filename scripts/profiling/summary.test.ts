import { expect, test } from 'vitest';
import { compare } from './compare.ts';
import { fixtureResults } from './report/fixture.ts';
import { summary } from './summary.ts';

const withGpu = (pct: number) => fixtureResults({ cpu: { dashboard: { clean: { 'chrome-gpu': pct } } } });

test('a summary lists the figures outside the noise, base then head, with their difference', () => {
  const head = withGpu(1.4);
  const base = withGpu(14.4);
  const text = summary(head, base, compare(head, base));
  expect(text).toContain(`## Profiling: \`${head.run.versions.app}\` against \`${base.run.versions.app}\``);
  expect(text).toContain('| Scenario | Figure | Base | Head | Difference |');
  expect(text).toContain('| dashboard | Dashboard, clean: CPU chrome-gpu | 14.4% | 1.4% | −13.0 pt (−90%) |');
  expect(text).toMatch(/\*\*\d+ of \d+ compared figures outside the noise thresholds\*\*/);
});

test('a summary of two equal runs says nothing changed, and one of a base that ran nothing says so', () => {
  const run = fixtureResults();
  expect(summary(run, run, compare(run, run))).toMatch(/None of the \d+ compared figures are outside/);
  const empty = fixtureResults({ without: ['startup', 'dashboard', 'tps', 'api'] });
  expect(summary(run, empty, compare(run, empty))).toContain('No figure could be compared');
});

test('a summary keeps to its row limit and counts the rest', () => {
  const head = withGpu(1.4);
  const base = withGpu(14.4);
  const comparison = compare(head, base);
  const text = summary(head, base, comparison, 1);
  expect(text.split('\n').filter((line) => line.startsWith('| dashboard |'))).toHaveLength(1);
  expect(text).toContain(`${String(comparison.changed.length - 1)} more in the report.`);
});

test('a summary names what failed on each side and the notes, on one line each', () => {
  const head = fixtureResults({ failed: [{ scenario: 'chat', error: 'no reply\nafter 60 s | gave up' }] });
  const base = fixtureResults({ without: ['tps'], failed: [{ scenario: 'tps', error: 'llama-server crashed' }] });
  const text = summary(head, base, compare(head, base));
  expect(text).toContain('- `tps` on the base: llama-server crashed');
  expect(text).toContain('- `chat` on the head: no reply after 60 s \\| gave up');
  expect(text).toContain('- `tps`: not in the reference run');
  expect(text).toMatch(/\d+ figures? ha(s|ve) no counterpart on the base/);
});

test('a summary warns when Chromium composited in software', () => {
  const run = fixtureResults({ gpuCompositing: 'disabled_software' });
  expect(summary(run, run, compare(run, run))).toContain('Chromium composited in software (disabled_software)');
});
