// Topology page: hardware graph (sysfs), model placement (llama-server logs) and inference phase.
// DOM-free module: shared by the server and the UI.

import type { Snapshot } from './monitor';
import type { ServerState } from './server';

export type TopologyNodeKind = 'cpu' | 'ram' | 'nvme' | 'gpu' | 'chipset';

export interface TopologyNode {
  /** `cpu`, `ram`, `pci:<busId>` (GPU, NVMe), `chipset:<busId of the switch>`. */
  id: string;
  kind: TopologyNodeKind;
  label: string;
  /** sysfs PCI address (`0000:01:00.0`), same format as `GpuSample.busId` and the `hiddenGpus` setting. */
  busId?: string;
  vendor?: 'nvidia' | 'amd' | 'intel' | 'other';
  /** Block device of an NVMe (`nvme0n1`): ties the node to `DiskSample.perDisk` and `model.disk`. */
  block?: string;
  /** Static facts shown in the tooltip (model, cores, size…); null = unknown. */
  detail: Record<string, string | number | null>;
}

export interface TopologyLink {
  id: string;
  /** CPU side (upstream). */
  from: string;
  to: string;
  kind: 'pcie' | 'memory' | 'internal';
  /** Link capability (min of both ends) and current state; null = unknown. */
  genMax: number | null;
  widthMax: number | null;
  genCur: number | null;
  widthCur: number | null;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  links: TopologyLink[];
  at: number;
}

/** Model, KV cache and compute bytes of a device, from the loading logs. */
export interface PlacementBuffer {
  /** ggml name: `CUDA0`, `ROCm0`, `Vulkan1`, `CPU`, `CPU_Mapped`, `CUDA_Host`… */
  device: string;
  /** PCI address of the device (“using device” line), null for the host or when not logged. */
  busId: string | null;
  modelBytes: number;
  /** KV cache, plus the recurrent state (“RS”) of hybrid models. */
  kvBytes: number;
  computeBytes: number;
  /**
   * Spread from the `Meta()` buffers of -sm tensor (by -ts, equal parts without it): llama-server only logs the
   * largest part of each one.
   */
  estimated?: boolean;
}

/**
 * Peer-to-peer between GPUs, as far as the logs tell:
 * - `active`: NCCL reports a channel going from GPU to GPU (needs `NCCL_DEBUG=INFO`);
 * - `unavailable`: the launch set `GGML_CUDA_P2P`, and NCCL reports that the driver does not allow it (its channels go
 *   through host memory);
 * - `requested`: the launch set `GGML_CUDA_P2P` and nothing says whether the driver allows it (llama.cpp enables it
 *   where it can, silently).
 */
export type P2pStatus = 'active' | 'unavailable' | 'requested';

export interface ModelPlacement {
  /** Number of the “[llama-webui] launch:” line it comes from. */
  launchSeq: number;
  /** “offloaded N/M layers to GPU”; null until that line has gone by. */
  layers: { offloaded: number; total: number } | null;
  buffers: PlacementBuffer[];
  /** Direct transfers between the GPUs of a backend (peer-to-peer); absent when neither requested nor reported. */
  p2p?: P2pStatus;
}

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

export type Phase = 'stopped' | 'loading' | 'idle' | 'prompt' | 'generating';

export const PHASE_LABEL: Record<Phase, string> = {
  stopped: 'Stopped',
  loading: 'Loading',
  idle: 'Idle',
  prompt: 'Prompt',
  generating: 'Generating',
};

/** What llama-server is doing right now, from the supervisor state and the slots of the last tick. */
export function phaseOf(state: ServerState | undefined, snapshot: Snapshot | null): Phase {
  if (!state || state.kind === 'idle' || state.kind === 'stopping' || state.kind === 'crashed') return 'stopped';
  if (state.kind === 'starting' || snapshot?.health === 'loading') return 'loading';
  const busy = (snapshot?.slots ?? []).filter((s) => s.processing);
  if (busy.length === 0) return 'idle';
  // No token generated yet: the prompt is being processed. `n_prompt_tokens` won't do: it is the slot's context, which
  // grows with the generated tokens, and `n_prompt_tokens_processed` leaves out what came from the cache.
  return busy.some((s) => s.nDecoded === 0) ? 'prompt' : 'generating';
}

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
export function pcieBps(gen: number | null, width: number | null): number | null {
  if (gen === null || width === null || width <= 0) return null;
  const lane = LANE_BPS[gen];
  return lane === undefined ? null : lane * width;
}
