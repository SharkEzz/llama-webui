import { expect, test } from 'bun:test';
import type { LogLine, ServerState } from '@llama-webui/shared';
import { LogBuffer } from '../logs/buffer';
import { PlacementTracker, parsePlacement } from './placement';

const MiB = 1024 ** 2;
const fixture = async () =>
  (await Bun.file(`${import.meta.dir}/../../testdata/llama-server-load.txt`).text()).trimEnd();
const lines = (text: string, from = 0): LogLine[] =>
  text.split('\n').map((t, i) => ({ seq: from + i, text: t, level: 'info', kind: 'other' }));

test('parsePlacement: real llama-server start, buffers summed per device, bus ids from « using device »', async () => {
  const p = parsePlacement(lines(await fixture()));
  expect(p).not.toBeNull();
  expect(p!.launchSeq).toBe(0);
  expect(p!.layers).toEqual({ offloaded: 49, total: 49 });
  expect(p!.buffers.map((b) => b.device)).toEqual(['CPU_Mapped', 'CUDA0', 'CUDA1', 'ROCm0', 'CUDA_Host']);
  const by = new Map(p!.buffers.map((b) => [b.device, b]));
  expect(by.get('CUDA0')).toEqual({
    device: 'CUDA0',
    busId: '0000:01:00.0',
    modelBytes: 12441.95 * MiB,
    kvBytes: 80 * MiB,
    computeBytes: 285.56 * MiB,
  });
  expect(by.get('ROCm0')!.busId).toBe('0000:08:00.0');
  expect(by.get('CPU_Mapped')).toEqual({
    device: 'CPU_Mapped',
    busId: null,
    modelBytes: (260.5 + 27465.95) * MiB,
    kvBytes: 0,
    computeBytes: 0,
  });
  expect(by.get('CUDA_Host')).toMatchObject({ busId: null, modelBytes: 0, computeBytes: 63.98 * MiB });
});

test('parsePlacement: real MTP + mmproj start, compute per context (last reservation wins), recurrent state with the KV', async () => {
  const text = (await Bun.file(`${import.meta.dir}/../../testdata/llama-server-load-mtp.txt`).text()).trimEnd();
  const p = parsePlacement(lines(text))!;
  expect(p.layers).toEqual({ offloaded: 66, total: 66 });
  const by = new Map(p.buffers.map((b) => [b.device, b]));
  // Main context 504.08; the mmproj's own 248.10 (reserve_compute_meta) left out.
  expect(by.get('CUDA0')!.computeBytes).toBeCloseTo(504.08 * MiB, 0);
  expect(by.get('CUDA1')!.computeBytes).toBeCloseTo(414.06 * MiB, 0);
  // Main context 414.06 + MTP context 454.06, reserved twice: counted once.
  expect(by.get('ROCm0')!.computeBytes).toBeCloseTo((414.06 + 454.06) * MiB, 0);
  expect(by.get('CUDA_Host')!.computeBytes).toBeCloseTo((352.09 + 302.07) * MiB, 0);
  // KV of the MTP context counted with the model's, and the recurrent state (RS) of this hybrid model with the KV.
  expect(by.get('ROCm0')!.kvBytes).toBeCloseTo((1260 + 252 + 187.03) * MiB, 0);
  expect(by.get('CUDA0')!.kvBytes).toBeCloseTo((1260 + 211.97) * MiB, 0);
  expect(by.get('CUDA1')!.kvBytes).toBeCloseTo((1512 + 199.5) * MiB, 0);
  expect(by.get('ROCm0')!.modelBytes).toBeCloseTo(4530.42 * MiB, 0);
});

test('parsePlacement: at -lv 5 the -fit probes (no-alloc loads, 0 MiB buffers, own contexts) are left out', async () => {
  const text = (await Bun.file(`${import.meta.dir}/../../testdata/llama-server-load-mtp-lv5.txt`).text()).trimEnd();
  // The probes print their « offloaded » lines and 0 MiB model buffers before the real load.
  expect(text.split('\n').filter((l) => /offloaded \d+\/\d+ layers/.test(l))).toHaveLength(3);
  const p = parsePlacement(lines(text))!;
  expect(p.layers).toEqual({ offloaded: 66, total: 66 });
  const by = new Map(p.buffers.map((b) => [b.device, b]));
  expect(p.buffers.map((b) => b.device)).toEqual(['CPU_Mapped', 'CUDA0', 'CUDA1', 'ROCm0', 'CUDA_Host']);
  expect(by.get('CUDA0')).toMatchObject({ busId: '0000:01:00.0' });
  expect(by.get('CUDA0')!.modelBytes).toBeCloseTo(3028.39 * MiB, 0);
  expect(by.get('ROCm0')!.modelBytes).toBeCloseTo(4530.42 * MiB, 0);
  expect(by.get('CPU_Mapped')!.modelBytes).toBeCloseTo(388.38 * MiB, 0);
  // Same totals as the -lv 4 start: the probes' KV (0 MiB) and compute reservations are not added.
  expect(by.get('ROCm0')!.kvBytes).toBeCloseTo((1260 + 252 + 187.03) * MiB, 0);
  expect(by.get('CUDA1')!.computeBytes).toBeCloseTo(414.06 * MiB, 0);
  expect(by.get('ROCm0')!.computeBytes).toBeCloseTo((414.06 + 454.06) * MiB, 0);
  expect(by.get('CUDA_Host')!.computeBytes).toBeCloseTo((352.09 + 302.07) * MiB, 0);
});

test('parsePlacement: the main model only, not a draft model (-md) nor the mmproj buffers', async () => {
  const main = (await fixture()).split('\n');
  const loaded = main.findIndex((l) => l.includes('model loaded'));
  const text = [
    main[0]!,
    // mmproj memory estimate, logged before the main model loads
    'reserve_compute_meta:      CUDA0 compute buffer size =    50.00 MiB',
    ...main.slice(1, loaded),
    // draft model
    'llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 5070 Ti) (0000:01:00.0) - 2000 MiB free',
    'load_tensors: offloaded 25/25 layers to GPU',
    'load_tensors:        CUDA0 model buffer size =   500.00 MiB',
    'llama_kv_cache:      CUDA0 KV buffer size =    10.00 MiB',
    'sched_reserve:      CUDA0 compute buffer size =    20.00 MiB',
    // mmproj
    'clip_ctx: CLIP using CUDA0 backend',
    'reserve_compute_meta:      CUDA0 compute buffer size =    50.00 MiB',
    ...main.slice(loaded),
  ].join('\n');
  const p = parsePlacement(lines(text))!;
  expect(p.layers).toEqual({ offloaded: 49, total: 49 });
  expect(p.buffers.find((b) => b.device === 'CUDA0')).toEqual({
    device: 'CUDA0',
    busId: '0000:01:00.0',
    modelBytes: 12441.95 * MiB,
    kvBytes: 80 * MiB,
    computeBytes: 285.56 * MiB,
  });
});

test('parsePlacement: only the last launch counts; no launch → null; bare lines (no timestamp) parse too', async () => {
  const first = lines(await fixture());
  const second = lines(
    [
      '[llama-webui] lancement: llama-server -m other.gguf',
      'llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 5070 Ti) (0000:01:00.0) - 15683 MiB free',
      'load_tensors: offloaded 10/33 layers to GPU',
      'load_tensors:        CUDA0 model buffer size =  1000.00 MiB',
    ].join('\n'),
    first.length,
  );
  const p = parsePlacement([...first, ...second]);
  expect(p).toEqual({
    launchSeq: first.length,
    layers: { offloaded: 10, total: 33 },
    buffers: [{ device: 'CUDA0', busId: '0000:01:00.0', modelBytes: 1000 * MiB, kvBytes: 0, computeBytes: 0 }],
  });
  expect(parsePlacement(first.slice(1))).toBeNull();
  // A launch whose model is still loading: known, but empty.
  expect(parsePlacement(second.slice(0, 1))).toEqual({ launchSeq: first.length, layers: null, buffers: [] });
});

const flush = () => new Promise<void>((r) => queueMicrotask(() => queueMicrotask(r)));

class FakeSupervisor {
  state: ServerState = { kind: 'idle' };
  private fns = new Set<(s: ServerState) => void>();
  subscribe(fn: (s: ServerState) => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  set(s: ServerState) {
    this.state = s;
    for (const fn of this.fns) fn(s);
  }
}
const ready: ServerState = { kind: 'ready', profile: 'p', profileId: 1, pid: 1, port: 8080, since: 0 };

test('PlacementTracker: replays the ring at construction, follows new lines and the server state', async () => {
  const logs = new LogBuffer(100);
  const sup = new FakeSupervisor();
  const text = await fixture();
  for (const l of text.split('\n')) logs.push(l);
  sup.state = { ...ready, kind: 'starting' };

  const tracker = new PlacementTracker({ logs, supervisor: sup, memory: { last: null } });
  expect(tracker.current?.layers).toEqual({ offloaded: 49, total: 49 });

  const seen: (number | null)[] = [];
  tracker.onChange((p) => seen.push(p?.buffers.length ?? null));
  logs.push('srv  log_server_r: request: POST /completion');
  await flush();
  expect(seen).toEqual([]); // nothing relevant: no recompute, no event

  logs.push('load_tensors:        CUDA1 model buffer size =     1.00 MiB');
  await flush();
  expect(seen).toEqual([5]); // the same five devices, CUDA1 grew: a change
  expect(tracker.current!.buffers.find((b) => b.device === 'CUDA1')!.modelBytes).toBe((11715.43 + 1) * MiB);

  sup.set({ kind: 'idle' });
  expect(tracker.current).toBeNull();
  expect(seen).toEqual([5, null]);
  sup.set(ready);
  expect(tracker.current?.buffers).toHaveLength(5);
  tracker.dispose();
});

test('PlacementTracker: an external server has no placement even if the ring holds an old launch', async () => {
  const logs = new LogBuffer(100);
  for (const l of (await fixture()).split('\n')) logs.push(l);
  const sup = new FakeSupervisor();
  sup.state = { kind: 'external', pid: null, port: 8080 };
  const tracker = new PlacementTracker({ logs, supervisor: sup, memory: { last: null } });
  expect(tracker.current).toBeNull();
  sup.set({ kind: 'crashed', profile: 'p', profileId: 1, exitCode: 1, signal: null, at: 0 });
  expect(tracker.current).toBeNull();
  tracker.dispose();
});

test('PlacementTracker: the launch evicted from the ring keeps the placement of the same server, across reloads', async () => {
  const text = (await fixture()).split('\n');
  const logs = new LogBuffer(text.length);
  for (const l of text) logs.push(l);
  const sup = new FakeSupervisor();
  sup.state = { ...ready, kind: 'starting' };
  const memory = { last: null };
  const tracker = new PlacementTracker({ logs, supervisor: sup, memory });
  expect(tracker.current?.buffers).toHaveLength(5);

  // -lv 4 or a sweep: request logs push the launch line out of the ring.
  for (let i = 0; i < text.length; i++) logs.push(`srv  log_server_r: request ${i}`);
  sup.set(ready);
  expect(tracker.current?.layers).toEqual({ offloaded: 49, total: 49 });
  tracker.dispose();

  // bun --hot: a new tracker, the ring without the launch, the same server.
  const reloaded = new PlacementTracker({ logs, supervisor: sup, memory });
  expect(reloaded.current?.buffers).toHaveLength(5);
  // Another server (new PID) whose launch is not in the ring: unknown, not the old placement.
  sup.set({ ...ready, pid: 2 });
  expect(reloaded.current).toBeNull();
  sup.set(ready);
  expect(reloaded.current).not.toBeNull();
  // Stopped: forgotten, even if the same PID comes back.
  sup.set({ kind: 'idle' });
  sup.set(ready);
  expect(reloaded.current).toBeNull();
  reloaded.dispose();
});
