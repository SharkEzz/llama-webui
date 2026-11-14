/**
 * NVML sampling loop, run in a child process (`sampler.ts`): PCIe throughput counters block ~50 ms per GPU, and a call
 * stuck in the driver must not hold the server's exit.
 * Protocol: main → { type: "start", intervalMs, needs, lib? } then { type: "configure", intervalMs, needs } when
 * the settings change; worker → { type: "ready" } | { type: "error", message } | { type: "sample", snapshot }.
 *
 * Run as is by Node in development (type stripping: its imports keep their `.ts` extension, and it imports nothing
 * but types outside this graph), bundled to `.output/server/nvml-worker.mjs` in production (`compiled` hook of
 * `vite.config.ts`).
 */

import { type GpuNeeds, MEASURE_ALL } from '../needs.ts';
import { deviceHandles, readNvml } from './read.ts';
import { openNvml } from './symbols.ts';

/** `lib`: the library to open (`LLAMA_WEBUI_NVML_LIB`), else `libnvidia-ml.so.1`. */
type Msg = { type?: string; intervalMs?: number; needs?: GpuNeeds; lib?: string };

const send = process.send?.bind(process);
if (!send) throw new Error('the NVML sampler runs in a child process with an IPC channel (sampler.ts)');
// The server is gone (even killed): stop sampling.
process.on('disconnect', () => process.exit(0));

let intervalMs = 1000;
let needs: GpuNeeds = MEASURE_ALL;
let started = false;

const apply = (msg: Msg) => {
  intervalMs = Math.max(100, msg.intervalMs ?? intervalMs);
  needs = msg.needs ?? needs;
};

process.on('message', (msg: Msg) => {
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
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  send({ type: 'ready' });
  const loop = () => {
    const t0 = performance.now();
    try {
      send({ type: 'sample', snapshot: readNvml(lib, handles, needs) });
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    setTimeout(loop, Math.max(0, intervalMs - (performance.now() - t0)));
  };
  loop();
});
