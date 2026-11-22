import { expect, test } from 'vitest';
import { cpuWindow, type ProcSample } from './procs.ts';

/** A sample of one process per group (its pid is the group's name), unless a group's ticks are given per pid. */
const sample = (
  t: number,
  groups: Record<string, [utime: number, stime: number] | Record<number, [utime: number, stime: number]>>,
  threads: Record<string, number> = {},
): ProcSample => {
  const procs: ProcSample['procs'] = {};
  for (const [group, ticks] of Object.entries(groups)) {
    const byPid = Array.isArray(ticks) ? { [group]: ticks } : ticks;
    for (const [pid, [utime, stime]] of Object.entries(byPid)) procs[pid] = { group, utime, stime, rssKb: 2048 };
  }
  return { t, procs, threads, gpuBusy: {} };
};

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

test('one process of a group exiting mid-window keeps the ticks the others spent', () => {
  // helper 7 (1000 ticks of lifetime) exits; helper 8 spends 50 ticks (0.5 s) over the 10 s
  const w = cpuWindow(
    [
      sample(0, { 'chrome-other': { 7: [1000, 0], 8: [10, 0] } }),
      sample(5000, { 'chrome-other': { 7: [1000, 0], 8: [35, 0] } }),
      sample(10_000, { 'chrome-other': { 8: [60, 0] } }),
    ],
    100,
  );
  expect(w.cpuPct['chrome-other']).toBeCloseTo(5);
});

test('a pooled thread exiting mid-window keeps the ticks of the threads of its name that remain', () => {
  const w = cpuWindow(
    [
      sample(0, {}, { 'chrome-gpu/ThreadPoolForeg\t11': 500, 'chrome-gpu/ThreadPoolForeg\t12': 0 }),
      sample(10_000, {}, { 'chrome-gpu/ThreadPoolForeg\t12': 100 }),
    ],
    100,
  );
  expect(w.threadPct['chrome-gpu/ThreadPoolForeg']).toBeCloseTo(10);
});

test('the GPU gauge is the mean of its readings', () => {
  const a = { ...sample(0, {}), gpuBusy: { '0000:0d:00.0': 40 } };
  const b = { ...sample(1000, {}), gpuBusy: { '0000:0d:00.0': 60 } };
  expect(cpuWindow([a, b], 100).gpuBusyPct['0000:0d:00.0']).toBe(50);
});
