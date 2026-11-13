import { readFile } from 'node:fs/promises';
import { type LogLine, P2P_LOG_LINE, type ServerState } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import { LogBuffer } from '../logs/buffer';
import { PlacementTracker, parsePlacement } from './placement';

const MiB = 1024 ** 2;
const fixture = async () =>
  (await readFile(`${import.meta.dirname}/../../../../testdata/llama-server-load.txt`, 'utf8')).trimEnd();
const lines = (text: string, from = 0): LogLine[] =>
  text.split('\n').map((t, i) => ({ seq: from + i, text: t, level: 'info', kind: 'other' }));

test('parsePlacement: real llama-server start, buffers summed per device, bus ids from “using device”', async () => {
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
  const text = (await readFile(`${import.meta.dirname}/../../../../testdata/llama-server-load-mtp.txt`, 'utf8')).trimEnd();
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
  const text = (
    await readFile(`${import.meta.dirname}/../../../../testdata/llama-server-load-mtp-lv5.txt`, 'utf8')
  ).trimEnd();
  // The probes print their “offloaded” lines and 0 MiB model buffers before the real load.
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
      '[llama-webui] launch: llama-server -m other.gguf',
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
const ready: ServerState = {
  kind: 'ready',
  profile: 'p',
  profileId: 1,
  pid: 1,
  host: '127.0.0.1',
  port: 8080,
  since: 0,
};

test('PlacementTracker: replays the ring at construction, follows new lines and the server state', async () => {
  const logs = new LogBuffer(100);
  const sup = new FakeSupervisor();
  const text = await fixture();
  for (const l of text.split('\n')) logs.push(l);
  sup.state = { ...ready, kind: 'starting' };

  const tracker = new PlacementTracker({ logs, supervisor: sup });
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
  const tracker = new PlacementTracker({ logs, supervisor: sup });
  expect(tracker.current).toBeNull();
  sup.set({ kind: 'crashed', profile: 'p', profileId: 1, exitCode: 1, signal: null, at: 0 });
  expect(tracker.current).toBeNull();
  tracker.dispose();
});

test('PlacementTracker: the launch evicted from the ring keeps the placement of the same server', async () => {
  const text = (await fixture()).split('\n');
  const logs = new LogBuffer(text.length);
  for (const l of text) logs.push(l);
  const sup = new FakeSupervisor();
  sup.state = { ...ready, kind: 'starting' };
  const tracker = new PlacementTracker({ logs, supervisor: sup });
  expect(tracker.current?.buffers).toHaveLength(5);

  // -lv 4 or a sweep: request logs push the launch line out of the ring.
  for (let i = 0; i < text.length; i++) logs.push(`srv  log_server_r: request ${i}`);
  sup.set(ready);
  expect(tracker.current?.layers).toEqual({ offloaded: 49, total: 49 });
  expect(tracker.current?.buffers).toHaveLength(5);
  // Another server (new PID) whose launch is not in the ring: unknown, not the old placement.
  sup.set({ ...ready, pid: 2 });
  expect(tracker.current).toBeNull();
  sup.set(ready);
  expect(tracker.current).not.toBeNull();
  // Stopped: forgotten, even if the same PID comes back.
  sup.set({ kind: 'idle' });
  sup.set(ready);
  expect(tracker.current).toBeNull();
  tracker.dispose();
});

test('parsePlacement: -sm tensor spreads the Meta() buffers over its devices by -ts, marked estimated (#17)', async () => {
  const text = (await readFile(`${import.meta.dirname}/../../../../testdata/llama-server-load-tensor.txt`, 'utf8')).trimEnd();
  const p = parsePlacement(lines(text))!;
  expect(p.layers).toEqual({ offloaded: 66, total: 66 });
  expect(p.buffers.some((b) => b.device.startsWith('Meta'))).toBe(false);
  const by = new Map(p.buffers.map((b) => [b.device, b]));
  // Meta() logs the largest part: CUDA1 (58) has it, CUDA0 gets 51/58 of it.
  expect(by.get('CUDA1')).toEqual({
    device: 'CUDA1',
    busId: null,
    modelBytes: 5931.79 * MiB,
    kvBytes: (320 + 336.66) * MiB,
    computeBytes: 150.14 * MiB,
    estimated: true,
  });
  expect(by.get('CUDA0')!.modelBytes).toBeCloseTo((5931.79 * 51 * MiB) / 58, 0);
  expect(by.get('CUDA0')!.computeBytes).toBe(150.14 * MiB);
  expect(by.get('CPU_Mapped')!.modelBytes).toBe(388.38 * MiB);
  expect(by.get('CPU_Mapped')!.estimated).toBeUndefined();
});

test('parsePlacement: -sm tensor without -ts gives each device an equal part (#17)', async () => {
  const text = (await readFile(`${import.meta.dirname}/../../../../testdata/llama-server-load-tensor.txt`, 'utf8'))
    .trimEnd()
    .replace(' -ts 51,58', '');
  const p = parsePlacement(lines(text))!;
  const by = new Map(p.buffers.map((b) => [b.device, b]));
  expect(by.get('CUDA0')!.modelBytes).toBe(5931.79 * MiB);
  expect(by.get('CUDA1')!.modelBytes).toBe(5931.79 * MiB);
});

test('parsePlacement: peer-to-peer is requested by the line llama-webui adds to the launch, for that launch only', async () => {
  const text = await fixture();
  expect(parsePlacement(lines(text))!.p2p).toBeUndefined();
  const [launch, ...rest] = text.split('\n');
  const withP2p = lines([launch, P2P_LOG_LINE, ...rest].join('\n'));
  const p = parsePlacement(withP2p)!;
  expect(p.p2p).toBe('requested');
  expect(p.buffers.map((b) => b.device)).toEqual(['CPU_Mapped', 'CUDA0', 'CUDA1', 'ROCm0', 'CUDA_Host']);
  // A later launch without it: the previous server's request does not carry over.
  const next = lines('[llama-webui] launch: llama-server -m other.gguf', withP2p.length);
  expect(parsePlacement([...withP2p, ...next])).toEqual({ launchSeq: withP2p.length, layers: null, buffers: [] });
});

test('parsePlacement: NCCL (NCCL_DEBUG=INFO) says whether peer-to-peer is really in use', async () => {
  const [launch, ...rest] = (await fixture()).split('\n');
  const nccl = (...extra: string[]) => parsePlacement(lines([launch, ...rest, ...extra].join('\n')))!.p2p;
  // The driver refuses it (consumer cards): NCCL says so and falls back to host memory.
  const refused = [
    'host:1205899:1205973 [1] NCCL INFO P2P is disabled between connected GPUs 1 and 0. You can repress this message with NCCL_IGNORE_DISABLED_P2P=1.',
    'host:1205899:1205984 [0] NCCL INFO Channel 00 : 0[0] -> 1[1] via SHM/direct',
    'host:1205899:1205983 [1] NCCL INFO Channel 00 : 1[1] -> 0[0] via SHM/direct',
  ];
  expect(nccl(P2P_LOG_LINE, ...refused)).toBe('unavailable');
  expect(nccl(P2P_LOG_LINE, refused[1]!)).toBe('unavailable');
  // Not requested and not available: nothing to report.
  expect(nccl(...refused)).toBeUndefined();
  // Channels going from GPU to GPU: active, with or without GGML_CUDA_P2P (NCCL enables peer access itself).
  const direct = [
    'host:7:8 [0] NCCL INFO Channel 00 : 0[0] -> 1[1] via P2P/CUMEM',
    'host:7:9 [1] NCCL INFO Channel 00 : 1[1] -> 0[0] via P2P/CUMEM',
  ];
  expect(nccl(P2P_LOG_LINE, ...direct)).toBe('active');
  expect(nccl(...direct)).toBe('active');
  // NCCL comes up with the context, after the lines of a draft model (a second “offloaded” line ends the buffers).
  expect(nccl('load_tensors: offloaded 5/5 layers to GPU', ...direct)).toBe('active');
});

test('parsePlacement: with -sm tensor, NCCL (NCCL_DEBUG=INFO) gives the PCI address of each CUDA device', async () => {
  const text = (await readFile(`${import.meta.dirname}/../../../../testdata/llama-server-load-tensor.txt`, 'utf8')).trimEnd();
  const bare = parsePlacement(lines(text))!;
  expect(
    bare.buffers.filter((b) => b.device.startsWith('CUDA') && !b.device.endsWith('Host')).map((b) => b.busId),
  ).toEqual([null, null]);
  const nccl = [
    'host:1:3 [1] NCCL INFO [Rank 1] ncclCommInitAll comm 0x5604f471ece0 rank 1 nranks 2 cudaDev 1 nvmlDev 1 busId 3000 commId 0x6a6789d3de0d6f12 - Init START',
    'host:1:2 [0] NCCL INFO [Rank 0] ncclCommInitAll comm 0x5604f3500b90 rank 0 nranks 2 cudaDev 0 nvmlDev 0 busId 1000 commId 0x6a6789d3de0d6f12 - Init START',
    // Domain, bus, device and function: 0001:0a:1f.3.
    'host:1:4 [2] NCCL INFO ncclCommInitAll comm 0x1 rank 2 nranks 3 cudaDev 2 nvmlDev 2 busId 10a1f3 commId 0x2 - Init COMPLETE',
  ];
  const p = parsePlacement(lines([text, ...nccl].join('\n')))!;
  const by = new Map(p.buffers.map((b) => [b.device, b.busId]));
  expect(by.get('CUDA0')).toBe('0000:01:00.0');
  expect(by.get('CUDA1')).toBe('0000:03:00.0');
  // The sizes are the same: only the addresses are added.
  expect(p.buffers.map((b) => ({ ...b, busId: null }))).toEqual(bare.buffers.map((b) => ({ ...b, busId: null })));
});

test('parsePlacement: the address llama-server logs itself wins over NCCL', async () => {
  const text = await fixture();
  const p = parsePlacement(
    lines(
      `${text}\nhost:1:2 [0] NCCL INFO ncclCommInitAll comm 0x1 rank 0 nranks 2 cudaDev 0 nvmlDev 0 busId 9000 commId 0x2 - Init COMPLETE`,
    ),
  )!;
  expect(p.buffers.find((b) => b.device === 'CUDA0')!.busId).toBe('0000:01:00.0');
});
