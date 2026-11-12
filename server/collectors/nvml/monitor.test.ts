import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GpuReading } from '../gpu';
import { NVML_WORKER, NvmlMonitor, type WorkerLike, workerUrl } from './monitor';

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
    unref() {},
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

test('workerUrl: next to the module from source, under the entrypoint root in the compiled executable', async () => {
  const fromSource = workerUrl(false);
  expect(fromSource).toBe(new URL('./worker.ts', import.meta.url).href);
  expect(existsSync(fileURLToPath(fromSource))).toBe(true);
  // The compile entrypoints' root is server/: the worker is embedded at server/<NVML_WORKER>.
  expect(existsSync(`${import.meta.dirname}/../../${NVML_WORKER}`)).toBe(true);
  expect(workerUrl(true)).toBe(new URL(`./${NVML_WORKER}`, pathToFileURL(Bun.main)).href);
});
