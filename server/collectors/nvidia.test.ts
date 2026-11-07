import { expect, test } from 'bun:test';
import { type GpuSample, normalizeBusId, selectUsedGpus } from './gpu';
import { NvidiaMonitor, parseComputeApps, parseNvidiaGpuLine } from './nvidia';

const fx = (n: string) => Bun.file(`${import.meta.dir}/../../testdata/${n}`).text();
const gpuCsv = await fx('nvidia-gpu.csv');
const LINE =
  '0, GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28, NVIDIA GeForce RTX 5070 Ti, 0, 5895, 16303, 38, 49.86, 00000000:01:00.0';

test('normalizeBusId', () => {
  expect(normalizeBusId('00000000:01:00.0')).toBe('0000:01:00.0');
  expect(normalizeBusId('0000:0D:00.0')).toBe('0000:0d:00.0');
});

test('parseNvidiaGpuLine', () => {
  expect(parseNvidiaGpuLine(LINE)).toEqual({
    key: 'nvidia:GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28',
    vendor: 'nvidia',
    name: 'NVIDIA GeForce RTX 5070 Ti',
    busId: '0000:01:00.0',
    utilPct: 0,
    vramUsedBytes: 5895 * 1024 ** 2,
    vramTotalBytes: 16303 * 1024 ** 2,
    tempC: 38,
    powerW: 49.86,
  });
  expect(parseNvidiaGpuLine(LINE.replace('49.86', '[N/A]'))!.powerW).toBeNull();
  expect(parseNvidiaGpuLine('garbage')).toBeNull();
});

test('parseComputeApps', async () => {
  const apps = parseComputeApps(await fx('nvidia-apps.csv'));
  expect(apps.length).toBe(2);
  expect(apps[0]).toEqual({
    pid: 49730,
    uuid: 'GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28',
    usedBytes: 5875 * 1024 ** 2,
  });
});

function fakeSpawn(chunks: string[], appsCsv = '') {
  return ((argv: string[]) => {
    const isApps = argv.some((a) => a.startsWith('--query-compute-apps'));
    const data = isApps ? [appsCsv] : chunks;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of data) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });
    return { stdout: stream, exited: Promise.resolve(0), kill() {} };
  }) as unknown as typeof Bun.spawn;
}

test('NvidiaMonitor streams lines split across chunks', async () => {
  const a = gpuCsv.slice(0, 30),
    b = gpuCsv.slice(30, 120),
    c = gpuCsv.slice(120);
  const mon = new NvidiaMonitor({ spawn: fakeSpawn([a, b, c]) });
  mon.start();
  await Bun.sleep(20);
  expect(mon.gpus().length).toBe(2);
  expect(mon.gpus()[1]!.name).toBe('NVIDIA GeForce RTX 5060 Ti');
  mon.stop();
});

test('NvidiaMonitor procVram from compute apps', async () => {
  const mon = new NvidiaMonitor({ spawn: fakeSpawn([gpuCsv], await fx('nvidia-apps.csv')) });
  await mon.refreshApps();
  const m = mon.procVram(49730);
  expect(m.get('nvidia:GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28')).toBe(5875 * 1024 ** 2);
  expect(mon.procVram(1).size).toBe(0);
});

test("compute apps with [N/A] memory keep the process on its card, counting the card's VRAM in use", async () => {
  expect(parseComputeApps('49730, GPU-x, [N/A]\n')).toEqual([{ pid: 49730, uuid: 'GPU-x', usedBytes: null }]);
  const mon = new NvidiaMonitor({
    spawn: fakeSpawn([gpuCsv], '49730, GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28, [N/A]\n'),
  });
  mon.start();
  await Bun.sleep(20);
  await mon.refreshApps();
  const card = mon.gpus().find((g) => g.key === 'nvidia:GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28')!;
  expect(mon.procVram(49730).get(card.key)).toBe(card.vramUsedBytes);
  mon.stop();
});

test('NvidiaMonitor without nvidia-smi stays empty', async () => {
  const spawn = (() => {
    throw new Error('ENOENT');
  }) as unknown as typeof Bun.spawn;
  const mon = new NvidiaMonitor({ spawn });
  mon.start();
  await mon.refreshApps();
  expect(mon.gpus()).toEqual([]);
  mon.stop();
});

test('a compute-apps read abandoned on timeout may fail later without reaching the process', async () => {
  let fail: ((e: Error) => void) | null = null;
  const spawn = (() => ({
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        fail = (e) => c.error(e);
      },
    }),
    exited: Promise.resolve(0),
    kill() {},
  })) as unknown as typeof Bun.spawn;
  const mon = new NvidiaMonitor({ spawn, appsTimeoutMs: 20 });
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    await mon.refreshApps();
    fail!(new Error('pipe torn down'));
    await Bun.sleep(20);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  expect(unhandled).toEqual([]);
});

const g = (key: string, busId: string, procVramBytes: number): GpuSample => ({
  key,
  vendor: 'amd',
  name: key,
  busId,
  utilPct: 0,
  vramUsedBytes: 0,
  vramTotalBytes: 1,
  tempC: null,
  powerW: null,
  procVramBytes,
});

test('selectUsedGpus', () => {
  const used = selectUsedGpus([
    g('b', '0000:08:00.0', 6 * 1024 ** 3),
    g('i', '0000:0d:00.0', 32 * 1024),
    g('a', '0000:01:00.0', 5 * 1024 ** 3),
  ]);
  expect(used.map((x) => x.key)).toEqual(['a', 'b']);
});

test("hung nvidia-smi compute-apps query times out, is killed, and calls don't pile up", async () => {
  const dir = `${Bun.env.TMPDIR ?? '/tmp'}/llt-nv-${process.pid}`;
  const bin = `${dir}/hung-nvidia-smi`;
  await Bun.write(bin, '#!/bin/sh\necho $$ >> "$(dirname "$0")/pids"\nexec sleep 30\n');
  await Bun.$`chmod +x ${bin}`;
  const mon = new NvidiaMonitor({ bin, appsTimeoutMs: 300 });
  const t0 = Date.now();
  await Promise.all([mon.refreshApps(), mon.refreshApps()]);
  expect(Date.now() - t0).toBeLessThan(2000);
  const pids = (await Bun.file(`${dir}/pids`).text()).trim().split('\n').map(Number);
  expect(pids.length).toBe(1);
  await Bun.sleep(50);
  expect(() => process.kill(pids[0]!, 0)).toThrow();
  await Bun.$`rm -rf ${dir}`;
});

test('configure restarts a running nvidia-smi stream at the new pace, and only then', async () => {
  const argv: string[][] = [];
  const kills: number[] = [];
  const spawn = ((a: string[]) => {
    argv.push(a);
    const i = argv.length;
    return {
      stdout: new ReadableStream<Uint8Array>({ start() {} }),
      exited: new Promise<number>(() => {}),
      kill: () => kills.push(i),
    };
  }) as unknown as typeof Bun.spawn;
  const mon = new NvidiaMonitor({ spawn, intervalMs: 1000 });
  mon.configure({ intervalMs: 500 }); // not started: nothing to restart
  expect(argv).toEqual([]);
  mon.start();
  mon.configure({ intervalMs: 500 }); // same pace
  expect(argv.length).toBe(1);
  expect(argv[0]!.slice(-2)).toEqual(['-lms', '500']);
  mon.configure({ intervalMs: 2000 });
  expect(kills).toEqual([1]);
  expect(argv[1]!.slice(-2)).toEqual(['-lms', '2000']);
  mon.stop();
});
