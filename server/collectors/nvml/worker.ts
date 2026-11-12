/**
 * NVML sampling loop, run off the main thread (`node:worker_threads`): PCIe throughput counters block ~50 ms per GPU.
 * Protocol: main → { type: "start", intervalMs, needs, lib? } then { type: "configure", intervalMs, needs } when
 * the settings change; worker → { type: "ready" } | { type: "error", message } | { type: "sample", snapshot }.
 *
 * Run as is by Node in development (type stripping: its imports keep their `.ts` extension, and it imports nothing
 * but types outside this graph), bundled to `dist/server/nvml-worker.js` in production (`vite.config.ts`).
 */

import { parentPort } from 'node:worker_threads';
import { type GpuNeeds, MEASURE_ALL } from '../needs.ts';
import { deviceHandles, readNvml } from './read.ts';
import { openNvml } from './symbols.ts';

/** `lib`: the library to open (`LLAMA_WEBUI_NVML_LIB`), else `libnvidia-ml.so.1`. */
type Msg = { type?: string; intervalMs?: number; needs?: GpuNeeds; lib?: string };

const port = parentPort;
if (!port) throw new Error('the NVML worker runs in a worker thread');

let intervalMs = 1000;
let needs: GpuNeeds = MEASURE_ALL;
let started = false;

const apply = (msg: Msg) => {
  intervalMs = Math.max(100, msg.intervalMs ?? intervalMs);
  needs = msg.needs ?? needs;
};

port.on('message', (msg: Msg) => {
  if (msg?.type === 'configure') return apply(msg); // read by the next round of the loop
  if (msg?.type !== 'start' || started) return;
  started = true;
  apply(msg);
  let lib: ReturnType<typeof openNvml>;
  let handles: bigint[];
  try {
    lib = openNvml(msg.lib);
    const rc = lib.nvmlInit_v2();
    if (rc !== 0) throw new Error(`nvmlInit_v2 returned ${rc}`);
    handles = deviceHandles(lib);
  } catch (err) {
    port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  port.postMessage({ type: 'ready' });
  const loop = () => {
    const t0 = performance.now();
    try {
      port.postMessage({ type: 'sample', snapshot: readNvml(lib, handles, needs) });
    } catch (err) {
      port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    setTimeout(loop, Math.max(0, intervalMs - (performance.now() - t0)));
  };
  loop();
});
