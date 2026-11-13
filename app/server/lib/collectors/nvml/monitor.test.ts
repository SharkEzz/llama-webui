import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vitest';
import { tempDir } from '../../testing/tempDir';
import type { GpuReading } from '../gpu';
import { NvmlMonitor, workerUrl } from './monitor';
import type { WorkerLike } from './sampler';

const GPU_A: GpuReading = {
  key: 'nvidia:GPU-a',
  vendor: 'nvidia',
  name: 'RTX',
  busId: '0000:01:00.0',
  utilPct: 10,
  vramUsedBytes: 1,
  vramTotalBytes: 2,
  tempC: 40,
  powerW: 50,
};

type FakeWorker = WorkerLike & { sent: unknown[]; terminated: boolean; emit(m: unknown): void; fail(e: unknown): void };

function fakeWorker(): FakeWorker {
  const w: FakeWorker = {
    sent: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(m) {
      w.sent.push(m);
    },
    terminate() {
      w.terminated = true;
    },
    emit(m) {
      w.onmessage?.({ data: m });
    },
    fail(e) {
      w.onerror?.(e);
    },
  };
  return w;
}

test('lowering the interval keeps the last sample fresh until the worker samples at the new pace', async () => {
  const w = fakeWorker();
  let now = 0;
  const p = NvmlMonitor.start({ intervalMs: 2000, createWorker: () => w, now: () => now });
  w.emit({ type: 'ready' });
  const mon = (await p)!;
  w.emit({ type: 'sample', snapshot: { gpus: [GPU_A], procs: [], system: { driver: null, cudaDriver: null } } });
  mon.configure({ intervalMs: 250, needs: { gpus: true, pcie: true, skipGpus: [] } });
  now = 1500; // the worker's pending round, scheduled at the old pace, has not run yet
  expect(mon.gpus()).toEqual([GPU_A]);
  w.emit({ type: 'sample', snapshot: { gpus: [GPU_A], procs: [], system: { driver: null, cudaDriver: null } } });
  now = 1500 + 1000; // new pace: 3 × 250 ms without a sample is stale
  expect(mon.gpus()).toEqual([]);
});

test('workerUrl: worker.ts next to the module in development, nvml-worker.js next to the bundle', () => {
  expect(workerUrl('file:///x/server/collectors/nvml/monitor.ts')).toBe('file:///x/server/collectors/nvml/worker.ts');
  expect(workerUrl('file:///x/dist/server/main.js')).toBe('file:///x/dist/server/nvml-worker.js');
  expect(workerUrl()).toBe(new URL('./worker.ts', import.meta.url).href);
  expect(existsSync(fileURLToPath(workerUrl()))).toBe(true);
});

test('a real worker with a missing NVML library resolves null (the nvidia-smi fallback)', async () => {
  const t0 = performance.now();
  const mon = await NvmlMonitor.start({ intervalMs: 1000, lib: '/nonexistent/libnvidia-ml.so.1' });
  expect(mon).toBeNull();
  // The worker's `error` message, not the 3 s ready timeout.
  expect(performance.now() - t0).toBeLessThan(2000);
});

/** An NVIDIA driver is loaded here (it ships NVML); CI has none. */
const nvmlHere = () => existsSync('/proc/driver/nvidia/version');

test.skipIf(!nvmlHere())('a real worker reads NVML when the library is here', async () => {
  const mon = await NvmlMonitor.start({ intervalMs: 200 });
  expect(mon).not.toBeNull();
  try {
    await vi.waitFor(() => expect(mon!.gpus().length).toBeGreaterThan(0), { timeout: 3000 });
    for (const g of mon!.gpus()) {
      expect(g.key).toMatch(/^nvidia:GPU-/);
      expect(g.busId).toMatch(/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/);
    }
    expect(mon!.system?.driver).toBeTruthy();
  } finally {
    mon!.stop();
  }
});

test('a sampler stuck in a native call does not hold the process when it exits', async () => {
  using dir = tempDir('lw-nvml-');
  // A sampler that announces itself, then blocks in libc's sleep(), as one stuck in an NVML call on a driver fault.
  const stuck = join(dir.path, 'stuck.mjs');
  writeFileSync(
    stuck,
    `import { dlopen } from 'node:ffi';
const { functions } = dlopen('libc.so.6', { sleep: { arguments: ['uint32'], return: 'uint32' } });
process.send('in');
functions.sleep(10);
`,
  );
  // The process under test: starts the sampler, waits until it is stuck, stops it and exits (as `shutdown()` does).
  // Its own timer stands for the server: the sampler is `unref()`'d and would not keep it up.
  const main = join(dir.path, 'main.mjs');
  writeFileSync(
    main,
    `import { sampler } from ${JSON.stringify(new URL('./sampler.ts', import.meta.url).href)};
const s = sampler(new URL(${JSON.stringify(pathToFileURL(stuck).href)}));
s.onerror = () => process.exit(2); // the fixture must start: a broken one fails the test
setTimeout(() => process.exit(3), 5000); // nor may it never answer; and this keeps the process up, as the server does
s.onmessage = () => setTimeout(() => { s.terminate(); process.exit(0); }, 100);
`,
  );
  const t0 = performance.now();
  const child = spawn(process.execPath, [main], { stdio: ['ignore', 'ignore', 'inherit'] });
  const [code] = (await once(child, 'exit')) as [number | null];
  expect(code).toBe(0);
  expect(performance.now() - t0).toBeLessThan(3000); // the sampler sleeps 10 s
}, 15_000);
