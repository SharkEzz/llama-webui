import { expect, test } from 'vitest';
import { compare } from '../compare.ts';
import { fixtureResults } from './fixture.ts';
import { renderReport } from './render.ts';

test('the report shows the measured scenarios only, with no broken number', () => {
  const html = renderReport(fixtureResults(), null);
  expect(html).not.toMatch(/NaN|undefined|Infinity|\[object/);
  expect(html).toContain('id="dashboard"');
  expect(html).not.toContain('id="chat"');
  expect(html).not.toContain('What changed');
  expect(html).not.toMatch(/(src|href)="https?:/);
});

test('a comparison lists what changed and prints the reference next to a figure', () => {
  const run = fixtureResults({ cpu: { dashboard: { clean: { 'chrome-gpu': 1.4 } } } });
  const reference = fixtureResults({ cpu: { dashboard: { clean: { 'chrome-gpu': 14.4 } } } });
  const html = renderReport(run, compare(run, reference));
  expect(html).toContain('What changed');
  expect(html).toMatch(/14\.4%[\s\S]{0,200}−13\.0/); // en-US percent, U+2212 minus, one decimal
});

test('an interrupted run renders, and says what failed', () => {
  const html = renderReport(
    fixtureResults({ without: ['tps'], failed: [{ scenario: 'chat', error: 'reply timed out' }] }),
    null,
  );
  expect(html).toContain('reply timed out');
  expect(html).not.toMatch(/NaN|undefined/);
});

test('software compositing is flagged at the top', () => {
  expect(renderReport(fixtureResults({ gpuCompositing: 'disabled_software' }), null)).toContain('software rendering');
});
