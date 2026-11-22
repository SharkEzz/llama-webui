import { expect, test } from 'vitest';
import { compare, VersionMismatch } from './compare.ts';
import { fixtureResults } from './report/fixture.ts';
import type { Results } from './results.ts';

const withGpu = (pct: number) => fixtureResults({ cpu: { dashboard: { clean: { 'chrome-gpu': pct } } } });

test('a difference over its threshold is a change, one under it is not', () => {
  const c = compare(withGpu(1.4), withGpu(14.4));
  expect(c.byId.get('dashboard.clean.cpu.chrome-gpu')).toMatchObject({ reference: 14.4, changed: true });
  expect(c.byId.get('dashboard.clean.cpu.chrome-gpu')?.delta).toBeCloseTo(-13);
  expect(c.changed[0]?.id).toBe('dashboard.clean.cpu.chrome-gpu');
  expect(compare(withGpu(14.1), withGpu(14.4)).changed).toEqual([]);
});

test('a tiny duration and a reference of zero are never a change by ratio alone', () => {
  const run = fixtureResults({ apiP50Ms: 0.3 }); // reference fixture: 0.1 ms
  const d = compare(run, fixtureResults()).byId.get('api./api/health.p50Ms');
  expect(d?.changed).toBe(false); // 200 % but 0.2 ms: under the 1 ms floor
  const zero = compare(withGpu(0.2), withGpu(0)).byId.get('dashboard.clean.cpu.chrome-gpu');
  expect(zero).toMatchObject({ relative: null, changed: false });
});

test('a scenario the reference lacks is shown without comparison, with a note', () => {
  const reference = fixtureResults({ without: ['tps'] });
  const c = compare(fixtureResults(), reference);
  expect([...c.byId.keys()].some((id) => id.startsWith('tps.'))).toBe(false);
  expect(c.notes.find((n) => n.scenario === 'tps')?.note).toContain('not in the reference');
});

test('a run of another format version is refused', () => {
  const old = { ...fixtureResults(), version: 0 };
  expect(() => compare(fixtureResults(), old as unknown as Results)).toThrow(VersionMismatch);
  expect(() => compare(fixtureResults(), old as unknown as Results)).toThrow(/version 0.*version 1/);
});

test('the GPU gauge is never reported as changed', () => {
  const c = compare(fixtureResults({ gpuBusy: 8 }), fixtureResults({ gpuBusy: 56 }));
  expect(c.changed.some((f) => f.kind === 'gpuBusy')).toBe(false);
});
