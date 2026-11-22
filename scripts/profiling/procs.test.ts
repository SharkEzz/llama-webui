import { expect, test } from 'vitest';
import { cpuWindow, type ProcSample } from './procs.ts';

const sample = (t: number, groups: Record<string, [utime: number, stime: number]>): ProcSample => ({
  t,
  threads: {},
  gpuBusy: {},
  groups: Object.fromEntries(Object.entries(groups).map(([k, [utime, stime]]) => [k, { utime, stime, rssKb: 2048 }])),
});

test('the CPU of a window is the tick difference over the wall time, as a percentage of one core', () => {
  const w = cpuWindow([sample(0, { server: [100, 50] }), sample(10_000, { server: [150, 100] })], 100);
  expect(w.wallMs).toBe(10_000);
  expect(w.cpuPct.server).toBeCloseTo(10); // 100 ticks = 1 s of CPU over 10 s
  expect(w.userPct.server).toBeCloseTo(5);
  expect(w.sysPct.server).toBeCloseTo(5);
  expect(w.rssMb.server).toBe(2);
});

test('a process that appears counts from zero, one that disappears is not negative', () => {
  const w = cpuWindow(
    [
      sample(0, { 'chrome-other': [40, 0] }),
      sample(5000, { 'llama-server': [500, 0] }),
      sample(10_000, { 'llama-server': [1000, 0] }),
    ],
    100,
  );
  expect(w.cpuPct['llama-server']).toBeCloseTo(100);
  expect(w.cpuPct['chrome-other']).toBe(0);
});

test('the GPU gauge is the mean of its readings', () => {
  const a = { ...sample(0, {}), gpuBusy: { '0000:0d:00.0': 40 } };
  const b = { ...sample(1000, {}), gpuBusy: { '0000:0d:00.0': 60 } };
  expect(cpuWindow([a, b], 100).gpuBusyPct['0000:0d:00.0']).toBe(50);
});
