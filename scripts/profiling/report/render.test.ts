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

test('the run names the page, and the rail links every section it has', () => {
  const html = renderReport(fixtureResults(), null);
  expect(html).toMatch(/<h1>[^<]+<\/h1>\n<p class="sub">Profiling run of llama-webui\.<\/p>/);
  const sections = [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
  const links = [...(/<nav aria-label="Sections">(.*?)<\/nav>/.exec(html)?.[1] ?? '').matchAll(/href="#([^"]+)"/g)];
  expect(sections.length).toBeGreaterThan(2);
  expect(links.map((m) => m[1])).toEqual(sections);
  // Without a comparison there is nothing to filter
  expect(html).not.toContain('id="changed-filter"');
});

test('a changed figure carries the window it was measured in, for the filter and the grouping', () => {
  const run = fixtureResults({ cpu: { dashboard: { clean: { 'chrome-gpu': 1.4 } } } });
  const reference = fixtureResults({ cpu: { dashboard: { clean: { 'chrome-gpu': 14.4 } } } });
  const html = renderReport(run, compare(run, reference));
  expect(html).toContain('compared with the run <code>');
  expect(html).toContain('id="changed-filter"');
  const row = /<tr data-group="([^"]+)"><td><span class="win">([^<]+): <\/span>CPU chrome-gpu/.exec(html);
  expect(row?.[1]).toBe(row?.[2]);
  expect(row?.[1]).toBeTruthy();
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

test("the collectors section shows a full and a light NVML sample and each call's cadence, and still reads a run without them", () => {
  const rx = { call: 'nvmlDeviceGetPcieThroughput(rx)', cpuMs: 2, wallMs: 42 };
  const before = fixtureResults();
  before.scenarios.collectors = {
    nvml: { gpus: 2, sampleCpuMs: 12, sampleWallMs: 90, calls: [rx] },
    reads: [],
    skipped: [],
  };
  const after = fixtureResults();
  after.scenarios.collectors = {
    nvml: {
      gpus: 2,
      sampleCpuMs: 12,
      sampleWallMs: 90,
      lightCpuMs: 6,
      lightWallMs: 8,
      avgCpuMs: 7.1,
      calls: [
        { ...rx, runsPerMinute: 12 },
        { call: 'nvmlDeviceGetPowerManagementLimit', cpuMs: 1.2, wallMs: 1.3, runsPerMinute: 6 },
        { call: 'nvmlDeviceGetFanSpeed', cpuMs: 1, wallMs: 1.1, runsPerMinute: 60 },
      ],
    },
    reads: [],
    skipped: [],
  };
  const old = renderReport(before, null);
  expect(old).toContain('full sample, CPU');
  expect(old).not.toContain('light sample, CPU');
  expect(old).not.toMatch(/NaN|undefined|Infinity/);
  const html = renderReport(after, compare(after, before));
  for (const text of ['light sample, CPU', 'on average at 1 Hz', 'every 5 s', 'every 10 s', 'every sample'])
    expect(html).toContain(text);
  expect(html).not.toMatch(/NaN|undefined|Infinity/);
});
