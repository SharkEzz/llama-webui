/**
 * NVML sampling loop, run off the UI thread: PCIe throughput counters block ~50 ms per GPU.
 * Protocol: main → { type: "start", intervalMs, needs } then { type: "configure", intervalMs, needs } when
 * the settings change; worker → { type: "ready" } | { type: "error", message } | { type: "sample", snapshot }.
 */

import { type GpuNeeds, MEASURE_ALL } from '../needs';
import { deviceHandles, readNvml } from './read';
import { openNvml } from './symbols';

declare const self: Worker;

type Msg = { type?: string; intervalMs?: number; needs?: GpuNeeds };

let intervalMs = 1000;
let needs: GpuNeeds = MEASURE_ALL;
let started = false;

const apply = (msg: Msg) => {
  intervalMs = Math.max(100, msg.intervalMs ?? intervalMs);
  needs = msg.needs ?? needs;
};

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as Msg;
  if (msg?.type === 'configure') return apply(msg); // read by the next round of the loop
  if (msg?.type !== 'start' || started) return;
  started = true;
  apply(msg);
  let lib: ReturnType<typeof openNvml>;
  let handles: number[];
  try {
    lib = openNvml();
    const rc = lib.nvmlInit_v2();
    if (rc !== 0) throw new Error(`nvmlInit_v2 a renvoyé ${rc}`);
    handles = deviceHandles(lib);
  } catch (err) {
    postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  postMessage({ type: 'ready' });
  const loop = () => {
    const t0 = performance.now();
    try {
      postMessage({ type: 'sample', snapshot: readNvml(lib, handles, needs) });
    } catch (err) {
      postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    setTimeout(loop, Math.max(0, intervalMs - (performance.now() - t0)));
  };
  loop();
};
