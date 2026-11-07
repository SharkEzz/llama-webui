import { expect, test } from 'bun:test';
import { MemBandwidthSampler, parsePerfLine } from './membw';

test('parsePerfLine: perf stat CSV, unsupported counts', () => {
  expect(parsePerfLine('1.005004537,1072663,,umc_cas_cmd.rd,2010102242,100,00,,')).toEqual({
    time: 1.005004537,
    count: 1072663,
    event: 'umc_cas_cmd.rd',
  });
  expect(parsePerfLine('2.000352061,<not supported>,,umc_cas_cmd.wr,0,100,00,,')).toEqual({
    time: 2.000352061,
    count: null,
    event: 'umc_cas_cmd.wr',
  });
  expect(parsePerfLine('# started on Fri Nov  7 07:00:00 2026')).toBeNull();
  expect(parsePerfLine('')).toBeNull();
});

/** A perf that prints the given lines (one chunk each, in order) and then stays open until killed (or exits at once). */
function fakePerf(
  linesFor: (argv: string[]) => string[] | Error,
  exitsAfter: (argv: string[]) => boolean = () => false,
) {
  const calls: string[][] = [];
  const spawn = ((argv: string[]) => {
    calls.push(argv);
    const lines = linesFor(argv);
    if (lines instanceof Error) throw lines;
    let killed = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(`${l}\n`));
        if (lines.length === 0 || exitsAfter(argv)) c.close();
        else killed = () => c.close();
      },
    });
    return { stdout: stream, exited: Promise.resolve(0), kill: () => killed() };
  }) as unknown as typeof Bun.spawn;
  return { spawn, calls };
}

const SYS = [
  '1.001,1072663,,umc_cas_cmd.rd,2010102242,100,00,,',
  '1.001,336721,,umc_cas_cmd.wr,2010094852,100,00,,',
  '2.001,252177,,umc_cas_cmd.rd,2010153752,100,00,,',
  '2.001,49654,,umc_cas_cmd.wr,2010149562,100,00,,',
];

test('MemBandwidthSampler: system read/write rates from per-interval CAS counts × 64 bytes', async () => {
  let now = 10_000;
  const perf = fakePerf((argv) => (argv.includes('-a') ? SYS : []));
  const s = new MemBandwidthSampler({ spawn: perf.spawn, now: () => now });
  s.start();
  await Bun.sleep(10);
  expect(perf.calls[0]).toEqual([
    'perf',
    'stat',
    '-a',
    '-e',
    'umc_cas_cmd.rd,umc_cas_cmd.wr',
    '-I',
    '1000',
    '-x',
    ',',
    '--log-fd',
    '1',
  ]);
  expect(s.available).toBe(true);
  const bw = s.sample()!;
  expect(bw.readBps).toBeCloseTo((252177 / 1) * 64, 0);
  expect(bw.writeBps).toBeCloseTo((49654 / 1) * 64, 0);
  // Stale after three intervals without a line.
  now += 3100;
  expect(s.sample()).toBeNull();
  s.stop();
});

test('MemBandwidthSampler: perf missing or event unknown → unknown, retried only after a delay', async () => {
  let now = 0;
  const perf = fakePerf(() => new Error('ENOENT'));
  const s = new MemBandwidthSampler({ spawn: perf.spawn, now: () => now });
  s.start();
  expect(s.available).toBe(false);
  expect(s.sample()).toBeNull();
  s.start();
  expect(perf.calls).toHaveLength(1); // no spawn loop
  now = 61_000;
  s.start();
  expect(perf.calls).toHaveLength(2);

  // perf starts but exits at once (event syntax error): no data, failed, no retry before the delay.
  const dead = fakePerf(() => []);
  const d = new MemBandwidthSampler({ spawn: dead.spawn, now: () => now });
  d.start();
  await Bun.sleep(10);
  expect(d.available).toBe(false);
  expect(d.sample()).toBeNull();
  expect(d.sample()).toBeNull();
  expect(dead.calls).toHaveLength(1);
  d.stop();
});

test('MemBandwidthSampler: one perf per followed PID, replaced when the PID changes, none for a dead PID', async () => {
  const perf = fakePerf((argv) => {
    if (argv.includes('-a')) return SYS;
    if (argv.includes('42')) return ['1.0,3028,,ls_any_fills_from_sys.dram_io_all,8122580,100,00,,'];
    return []; // PID 7: "Problems finding threads of monitor"
  });
  const s = new MemBandwidthSampler({ spawn: perf.spawn, now: () => 0 });
  s.start();
  s.setPid(42);
  await Bun.sleep(10);
  expect(perf.calls[1]).toEqual([
    'perf',
    'stat',
    '-p',
    '42',
    '-e',
    'ls_any_fills_from_sys.dram_io_all',
    '-I',
    '1000',
    '-x',
    ',',
    '--log-fd',
    '1',
  ]);
  expect(s.procSample()).toBe(3028 * 64);
  s.setPid(42);
  expect(perf.calls).toHaveLength(2); // same PID: nothing relaunched

  s.setPid(7);
  await Bun.sleep(10);
  expect(perf.calls).toHaveLength(3);
  expect(s.procSample()).toBeNull();
  s.setPid(7);
  expect(perf.calls).toHaveLength(3); // a PID perf could not attach to is not retried
  s.setPid(null);
  expect(s.procSample()).toBeNull();
  s.stop();
});

test('MemBandwidthSampler: a new interval restarts the streams with it', async () => {
  const perf = fakePerf((argv) =>
    argv.includes('-a') ? SYS : ['1.0,10,,ls_any_fills_from_sys.dram_io_all,1,100,00,,'],
  );
  const s = new MemBandwidthSampler({ spawn: perf.spawn, now: () => 0 });
  s.start();
  s.setPid(42);
  s.configure(500);
  await Bun.sleep(10);
  expect(perf.calls).toHaveLength(4);
  expect(perf.calls[2]).toContain('500');
  expect(perf.calls[3]).toContain('500');
  expect(s.sample()).not.toBeNull();
  expect(s.procSample()).toBe(10 * 64);
  s.stop();
});

test('MemBandwidthSampler: a PID perf cannot attach to is not retried, even when setPid runs every tick', async () => {
  let now = 0;
  const perf = fakePerf((argv) => (argv.includes('-a') ? SYS : []));
  const s = new MemBandwidthSampler({ spawn: perf.spawn, now: () => now });
  s.start();
  // Monitor order: setPid then procSample in the same tick, before perf's exit has been read.
  for (let tick = 0; tick < 5; tick++) {
    s.setPid(7);
    expect(s.procSample()).toBeNull();
    await Bun.sleep(5);
    now += 30_000;
  }
  expect(perf.calls.filter((c) => c.includes('-p'))).toHaveLength(1);
  s.stop();
});

test('MemBandwidthSampler: system perf failing every time is retried once per delay, not every tick', async () => {
  let now = 0;
  const perf = fakePerf(() => []); // exits at once, no output (no amd_umc PMU)
  const s = new MemBandwidthSampler({ spawn: perf.spawn, now: () => now });
  s.start();
  for (let i = 0; i < 200; i++) {
    await Bun.sleep(1);
    expect(s.sample()).toBeNull();
    now += 1000;
  }
  // 200 s of ticks: first spawn plus one retry per 60 s.
  expect(perf.calls).toHaveLength(4);
  s.stop();
});

test('MemBandwidthSampler: perf that dies after giving values is relaunched after the delay', async () => {
  let now = 0;
  const sysOnce = fakePerf(
    (argv) => (argv.includes('-a') ? SYS : ['1.0,10,,ls_any_fills_from_sys.dram_io_all,1,100,00,,']),
    () => true,
  );
  const s = new MemBandwidthSampler({ spawn: sysOnce.spawn, now: () => now });
  s.start();
  s.setPid(42);
  await Bun.sleep(10);
  expect(s.sample()).toBeNull(); // dead: no stale values
  expect(s.procSample()).toBeNull();
  expect(s.available).toBe(false);
  s.setPid(42);
  expect(sysOnce.calls).toHaveLength(2);
  now = 61_000;
  s.sample();
  s.setPid(42);
  expect(sysOnce.calls).toHaveLength(4);
  await Bun.sleep(10);
  s.stop();
});
