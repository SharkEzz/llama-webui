import { NodeServices } from '@effect/platform-node';
import { layer } from '@effect/vitest';
import { type LogLine, P2P_LOG_LINE, type PlacementBuffer } from '@llama-webui/shared';
import { Array as Arr, Effect, FileSystem, Option, Path, String as Str } from 'effect';
import { expect } from 'vitest';
import { parsePlacement } from './placementLog.ts';

const MiB = 1024 ** 2;

/** A file of `testdata/`, without its trailing newline. */
const readTestdata = Effect.fn('readTestdata')(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(path.resolve(import.meta.dirname, '../../../testdata', name));
  return Str.trimEnd(text);
});
const fixture = () => readTestdata('llama-server-load.txt');
const lines = (text: string, from = 0): LogLine[] =>
  Arr.map(Str.split(text, '\n'), (t, i) => ({ seq: from + i, text: t, level: 'info', kind: 'other' }));
const join = Arr.join('\n');
const devices = Arr.map((b: PlacementBuffer) => b.device);
const byDevice = (buffers: ReadonlyArray<PlacementBuffer>) => new Map(Arr.map(buffers, (b) => [b.device, b]));
const find = (buffers: ReadonlyArray<PlacementBuffer>, device: string) =>
  Option.getOrUndefined(Arr.findFirst(buffers, (b) => b.device === device));

layer(NodeServices.layer)((it) => {
  it.effect('parsePlacement: real llama-server start, buffers summed per device, bus ids from “using device”', () =>
    Effect.gen(function* () {
      const text = yield* fixture();
      const p = parsePlacement(lines(text));
      expect(p).not.toBeNull();
      expect(p!.launchSeq).toBe(0);
      expect(p!.layers).toEqual({ offloaded: 49, total: 49 });
      expect(devices(p!.buffers)).toEqual(['CPU_Mapped', 'CUDA0', 'CUDA1', 'ROCm0', 'CUDA_Host']);
      const by = byDevice(p!.buffers);
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
    }),
  );

  it.effect(
    'parsePlacement: real MTP + mmproj start, compute per context (last reservation wins), recurrent state with the KV',
    () =>
      Effect.gen(function* () {
        const text = yield* readTestdata('llama-server-load-mtp.txt');
        const p = parsePlacement(lines(text))!;
        expect(p.layers).toEqual({ offloaded: 66, total: 66 });
        const by = byDevice(p.buffers);
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
      }),
  );

  it.effect('parsePlacement: at -lv 5 the -fit probes (no-alloc loads, 0 MiB buffers, own contexts) are left out', () =>
    Effect.gen(function* () {
      const text = yield* readTestdata('llama-server-load-mtp-lv5.txt');
      // The probes print their “offloaded” lines and 0 MiB model buffers before the real load.
      expect(Arr.filter(Str.split(text, '\n'), (l) => /offloaded \d+\/\d+ layers/.test(l))).toHaveLength(3);
      const p = parsePlacement(lines(text))!;
      expect(p.layers).toEqual({ offloaded: 66, total: 66 });
      const by = byDevice(p.buffers);
      expect(devices(p.buffers)).toEqual(['CPU_Mapped', 'CUDA0', 'CUDA1', 'ROCm0', 'CUDA_Host']);
      expect(by.get('CUDA0')).toMatchObject({ busId: '0000:01:00.0' });
      expect(by.get('CUDA0')!.modelBytes).toBeCloseTo(3028.39 * MiB, 0);
      expect(by.get('ROCm0')!.modelBytes).toBeCloseTo(4530.42 * MiB, 0);
      expect(by.get('CPU_Mapped')!.modelBytes).toBeCloseTo(388.38 * MiB, 0);
      // Same totals as the -lv 4 start: the probes' KV (0 MiB) and compute reservations are not added.
      expect(by.get('ROCm0')!.kvBytes).toBeCloseTo((1260 + 252 + 187.03) * MiB, 0);
      expect(by.get('CUDA1')!.computeBytes).toBeCloseTo(414.06 * MiB, 0);
      expect(by.get('ROCm0')!.computeBytes).toBeCloseTo((414.06 + 454.06) * MiB, 0);
      expect(by.get('CUDA_Host')!.computeBytes).toBeCloseTo((352.09 + 302.07) * MiB, 0);
    }),
  );

  it.effect('parsePlacement: the main model only, not a draft model (-md) nor the mmproj buffers', () =>
    Effect.gen(function* () {
      const whole = yield* fixture();
      const main = Str.split(whole, '\n');
      const loaded = Option.getOrElse(
        Arr.findFirstIndex(main, (l) => Str.includes('model loaded')(l)),
        () => -1,
      );
      const text = join([
        main[0],
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
      ]);
      const p = parsePlacement(lines(text))!;
      expect(p.layers).toEqual({ offloaded: 49, total: 49 });
      expect(find(p.buffers, 'CUDA0')).toEqual({
        device: 'CUDA0',
        busId: '0000:01:00.0',
        modelBytes: 12441.95 * MiB,
        kvBytes: 80 * MiB,
        computeBytes: 285.56 * MiB,
      });
    }),
  );

  it.effect('parsePlacement: only the last launch counts; no launch → null; bare lines (no timestamp) parse too', () =>
    Effect.gen(function* () {
      const text = yield* fixture();
      const first = lines(text);
      const second = lines(
        join([
          '[llama-webui] launch: llama-server -m other.gguf',
          'llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 5070 Ti) (0000:01:00.0) - 15683 MiB free',
          'load_tensors: offloaded 10/33 layers to GPU',
          'load_tensors:        CUDA0 model buffer size =  1000.00 MiB',
        ]),
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
    }),
  );

  it.effect(
    'parsePlacement: -sm tensor spreads the Meta() buffers over its devices by -ts, marked estimated (#17)',
    () =>
      Effect.gen(function* () {
        const text = yield* readTestdata('llama-server-load-tensor.txt');
        const p = parsePlacement(lines(text))!;
        expect(p.layers).toEqual({ offloaded: 66, total: 66 });
        expect(Arr.some(p.buffers, (b) => Str.startsWith('Meta')(b.device))).toBe(false);
        const by = byDevice(p.buffers);
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
      }),
  );

  it.effect('parsePlacement: -sm tensor without -ts gives each device an equal part (#17)', () =>
    Effect.gen(function* () {
      const tensor = yield* readTestdata('llama-server-load-tensor.txt');
      const text = Str.replace(' -ts 51,58', '')(tensor);
      const p = parsePlacement(lines(text))!;
      const by = byDevice(p.buffers);
      expect(by.get('CUDA0')!.modelBytes).toBe(5931.79 * MiB);
      expect(by.get('CUDA1')!.modelBytes).toBe(5931.79 * MiB);
    }),
  );

  it.effect(
    'parsePlacement: peer-to-peer is requested by the line llama-webui adds to the launch, for that launch only',
    () =>
      Effect.gen(function* () {
        const text = yield* fixture();
        expect(parsePlacement(lines(text))!.p2p).toBeUndefined();
        const [launch, ...rest] = Str.split(text, '\n');
        const withP2p = lines(join([launch, P2P_LOG_LINE, ...rest]));
        const p = parsePlacement(withP2p)!;
        expect(p.p2p).toBe('requested');
        expect(devices(p.buffers)).toEqual(['CPU_Mapped', 'CUDA0', 'CUDA1', 'ROCm0', 'CUDA_Host']);
        // A later launch without it: the previous server's request does not carry over.
        const next = lines('[llama-webui] launch: llama-server -m other.gguf', withP2p.length);
        expect(parsePlacement([...withP2p, ...next])).toEqual({
          launchSeq: withP2p.length,
          layers: null,
          buffers: [],
        });
      }),
  );

  it.effect('parsePlacement: NCCL (NCCL_DEBUG=INFO) says whether peer-to-peer is really in use', () =>
    Effect.gen(function* () {
      const text = yield* fixture();
      const [launch, ...rest] = Str.split(text, '\n');
      const nccl = (...extra: string[]) => parsePlacement(lines(join([launch, ...rest, ...extra])))!.p2p;
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
    }),
  );

  it.effect('parsePlacement: with -sm tensor, NCCL (NCCL_DEBUG=INFO) gives the PCI address of each CUDA device', () =>
    Effect.gen(function* () {
      const text = yield* readTestdata('llama-server-load-tensor.txt');
      const bare = parsePlacement(lines(text))!;
      expect(
        Arr.map(
          Arr.filter(bare.buffers, (b) => Str.startsWith('CUDA')(b.device) && !Str.endsWith('Host')(b.device)),
          (b) => b.busId,
        ),
      ).toEqual([null, null]);
      const nccl = [
        'host:1:3 [1] NCCL INFO [Rank 1] ncclCommInitAll comm 0x5604f471ece0 rank 1 nranks 2 cudaDev 1 nvmlDev 1 busId 3000 commId 0x6a6789d3de0d6f12 - Init START',
        'host:1:2 [0] NCCL INFO [Rank 0] ncclCommInitAll comm 0x5604f3500b90 rank 0 nranks 2 cudaDev 0 nvmlDev 0 busId 1000 commId 0x6a6789d3de0d6f12 - Init START',
        // Domain, bus, device and function: 0001:0a:1f.3.
        'host:1:4 [2] NCCL INFO ncclCommInitAll comm 0x1 rank 2 nranks 3 cudaDev 2 nvmlDev 2 busId 10a1f3 commId 0x2 - Init COMPLETE',
      ];
      const p = parsePlacement(lines(join([text, ...nccl])))!;
      const by = new Map(Arr.map(p.buffers, (b) => [b.device, b.busId]));
      expect(by.get('CUDA0')).toBe('0000:01:00.0');
      expect(by.get('CUDA1')).toBe('0000:03:00.0');
      // The sizes are the same: only the addresses are added.
      const withoutBusId = Arr.map((b: PlacementBuffer) => ({ ...b, busId: null }));
      expect(withoutBusId(p.buffers)).toEqual(withoutBusId(bare.buffers));
    }),
  );

  it.effect('parsePlacement: the address llama-server logs itself wins over NCCL', () =>
    Effect.gen(function* () {
      const text = yield* fixture();
      const p = parsePlacement(
        lines(
          `${text}\nhost:1:2 [0] NCCL INFO ncclCommInitAll comm 0x1 rank 0 nranks 2 cudaDev 0 nvmlDev 0 busId 9000 commId 0x2 - Init COMPLETE`,
        ),
      )!;
      expect(find(p.buffers, 'CUDA0')!.busId).toBe('0000:01:00.0');
    }),
  );
});
