// Topology page: hardware graph (sysfs), model placement (llama-server logs) and inference phase.
// DOM-free module: shared by the server and the UI.

import { Array as Arr, Schema } from 'effect';
import { dual } from 'effect/Function';
import type { Snapshot } from './monitor.ts';
import type { ServerState } from './server.ts';

export const TopologyNodeKind = Schema.Literals(['cpu', 'ram', 'nvme', 'gpu', 'chipset']);
export type TopologyNodeKind = typeof TopologyNodeKind.Type;

export const TopologyNode = Schema.Struct({
  /** `cpu`, `ram`, `pci:<busId>` (GPU, NVMe), `chipset:<busId of the switch>`. */
  id: Schema.String,
  kind: TopologyNodeKind,
  label: Schema.String,
  /** sysfs PCI address (`0000:01:00.0`), same format as `GpuSample.busId` and the `hiddenGpus` setting. */
  busId: Schema.optionalKey(Schema.String),
  vendor: Schema.optionalKey(Schema.Literals(['nvidia', 'amd', 'intel', 'other'])),
  /** Block device of an NVMe (`nvme0n1`): ties the node to `DiskSample.perDisk` and `model.disk`. */
  block: Schema.optionalKey(Schema.String),
  /** Static facts shown in the tooltip (model, cores, size…); null = unknown. */
  detail: Schema.Record(Schema.String, Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))),
});
export type TopologyNode = typeof TopologyNode.Type;

export const TopologyLink = Schema.Struct({
  id: Schema.String,
  /** CPU side (upstream). */
  from: Schema.String,
  to: Schema.String,
  kind: Schema.Literals(['pcie', 'memory', 'internal']),
  /** Link capability (min of both ends) and current state; null = unknown. */
  genMax: Schema.NullOr(Schema.Int),
  widthMax: Schema.NullOr(Schema.Int),
  genCur: Schema.NullOr(Schema.Int),
  widthCur: Schema.NullOr(Schema.Int),
});
export type TopologyLink = typeof TopologyLink.Type;

export const TopologyGraph = Schema.Struct({
  nodes: Schema.Array(TopologyNode),
  links: Schema.Array(TopologyLink),
  at: Schema.Int,
});
export type TopologyGraph = typeof TopologyGraph.Type;

/** Model, KV cache and compute bytes of a device, from the loading logs. */
export const PlacementBuffer = Schema.Struct({
  /** ggml name: `CUDA0`, `ROCm0`, `Vulkan1`, `CPU`, `CPU_Mapped`, `CUDA_Host`… */
  device: Schema.String,
  /** PCI address of the device (“using device” line), null for the host or when not logged. */
  busId: Schema.NullOr(Schema.String),
  modelBytes: Schema.Finite,
  /** KV cache, plus the recurrent state (“RS”) of hybrid models. */
  kvBytes: Schema.Finite,
  computeBytes: Schema.Finite,
  /**
   * Spread from the `Meta()` buffers of -sm tensor (by -ts, equal parts without it): llama-server only logs the
   * largest part of each one.
   */
  estimated: Schema.optionalKey(Schema.Boolean),
});
export type PlacementBuffer = typeof PlacementBuffer.Type;

/**
 * Peer-to-peer between GPUs, as far as the logs tell:
 * - `active`: NCCL reports a channel going from GPU to GPU (needs `NCCL_DEBUG=INFO`);
 * - `unavailable`: the launch set `GGML_CUDA_P2P`, and NCCL reports that the driver does not allow it (its channels go
 *   through host memory);
 * - `requested`: the launch set `GGML_CUDA_P2P` and nothing says whether the driver allows it (llama.cpp enables it
 *   where it can, silently).
 */
export const P2pStatus = Schema.Literals(['active', 'unavailable', 'requested']);
export type P2pStatus = typeof P2pStatus.Type;

export const ModelPlacement = Schema.Struct({
  /** Number of the “[llama-webui] launch:” line it comes from. */
  launchSeq: Schema.Int,
  /** “offloaded N/M layers to GPU”; null until that line has gone by. */
  layers: Schema.NullOr(Schema.Struct({ offloaded: Schema.Int, total: Schema.Int })),
  buffers: Schema.Array(PlacementBuffer),
  /** Direct transfers between the GPUs of a backend (peer-to-peer); absent when neither requested nor reported. */
  p2p: Schema.optionalKey(P2pStatus),
});
export type ModelPlacement = typeof ModelPlacement.Type;

/** Host-side (RAM) buffers: `CPU`, `CPU_Mapped` (mmap from disk), `CPU_REPACK`, `CUDA_Host` (pinned)… */
export function hostDevice(device: string): boolean {
  return /^CPU(?:_|$)|_Host$/.test(device);
}

export function placementTotals(p: ModelPlacement): {
  modelBytes: number;
  gpuModelBytes: number;
  hostModelBytes: number;
} {
  let gpu = 0;
  let host = 0;
  for (const b of p.buffers) {
    if (hostDevice(b.device)) host += b.modelBytes;
    else gpu += b.modelBytes;
  }
  return { modelBytes: gpu + host, gpuModelBytes: gpu, hostModelBytes: host };
}

export const Phase = Schema.Literals(['stopped', 'loading', 'idle', 'prompt', 'generating']);
export type Phase = typeof Phase.Type;

export const PHASE_LABEL: Record<Phase, string> = {
  stopped: 'Stopped',
  loading: 'Loading',
  idle: 'Idle',
  prompt: 'Prompt',
  generating: 'Generating',
};

/** What llama-server is doing right now, from the supervisor state and the slots of the last tick. */
export const phaseOf: {
  (snapshot: Snapshot | null): (state: ServerState | undefined) => Phase;
  (state: ServerState | undefined, snapshot: Snapshot | null): Phase;
} = dual(2, (state: ServerState | undefined, snapshot: Snapshot | null): Phase => {
  if (state === undefined || state.kind === 'idle' || state.kind === 'stopping' || state.kind === 'crashed') {
    return 'stopped';
  }
  if (state.kind === 'starting' || snapshot?.health === 'loading') return 'loading';
  const busy = Arr.filter(snapshot?.slots ?? [], (s) => s.processing);
  if (Arr.isReadonlyArrayEmpty(busy)) return 'idle';
  // No token generated yet: the prompt is being processed. `n_prompt_tokens` won't do: it is the slot's context, which
  // grows with the generated tokens, and `n_prompt_tokens_processed` leaves out what came from the cache.
  return Arr.some(busy, (s) => s.nDecoded === 0) ? 'prompt' : 'generating';
});

/** Payload bandwidth per lane and direction (bytes/s), after encoding: Gen1 8b/10b, Gen3+ 128b/130b. */
const LANE_BPS: Record<number, number> = {
  1: 0.25e9,
  2: 0.5e9,
  3: 0.985e9,
  4: 1.969e9,
  5: 3.938e9,
  6: 7.563e9,
};

/** Capacity of a PCIe link per direction (bytes/s); null if the generation or width is unknown. */
export const pcieBps: {
  (width: number | null): (gen: number | null) => number | null;
  (gen: number | null, width: number | null): number | null;
} = dual(2, (gen: number | null, width: number | null): number | null => {
  if (gen === null || width === null || width <= 0) return null;
  const lane = LANE_BPS[gen];
  return lane === undefined ? null : lane * width;
});
