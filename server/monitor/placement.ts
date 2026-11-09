import {
  LAUNCH_LOG_PREFIX,
  type LogLine,
  type ModelPlacement,
  type PlacementBuffer,
  type ServerState,
} from '@llama-webui/shared';
import type { LogBuffer } from '../logs/buffer';

/*
 * How the loaded model is split across devices, read from llama-server's startup logs: “using device CUDA0
 * (…) (0000:01:00.0)”, “CUDA0 model buffer size = 12441.95 MiB”, “offloaded 49/49 layers to GPU”… llama-server
 * doesn't expose these figures through its API, and only logs the buffer sizes from -lv 4 on: `buildCommand()` adds
 * `-lv 4` to a profile that sets no verbosity.
 */

const MiB = 1024 ** 2;
const LAUNCH = LAUNCH_LOG_PREFIX;
/** Optional llama.cpp prefix (“0.11.852.017 I”), kept in `LogLine.text`. */
const PREFIX = /^(?:\d+\.\d+(?:\.\d+)*\s+[IWEDT]\s+)?/;
const USING = /using device (\S+) \(.*\) \(([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])\)/i;
const LAYERS = /offloaded (\d+)\/(\d+) layers to GPU/;
/** `RS`: state of a hybrid model's recurrent layers (Mamba, DeltaNet…), the equivalent of their KV cache. */
const BUFFER = /(\S+) (model|KV|RS|compute) buffer size =\s*([\d.]+) MiB/;
/** A new context (the main one, then the draft's or the MTP's): it has its own compute buffers. */
const CONTEXT = /llama_context: constructing llama_context/;
/** New reservation of the current context: its compute buffers replace those of the previous one. */
const RESERVE = /sched_reserve: reserving/;
/** Multimodal projector buffers (mmproj, clip.cpp): not the model, and estimated before it is even loaded. */
const MMPROJ = /^(?:clip\w*|(?:reserve|alloc)_compute_meta):/;
/**
 * Start and end of fitting to memory (-fit, on by default), the end being written whatever the outcome. Its probes
 * load the model without allocating (layers, 0 MiB buffers, contexts, then the draft or the MTP): at -lv 5, their lines
 * come out in between and are not the real load.
 */
const FIT_START = /fitting params to device memory \.\.\./;
const FIT_DONE = /common_fit_params: fitting params to free memory took/;
/** One device of the Meta device that -sm tensor creates: its buffers are logged as `Meta()`, at their largest. */
const META_MEMBER = /llama_prepare_model_devices: - device \d+: (\S+)/;
const META = /^Meta\(/;
/** -ts / --tensor-split on the launch line: “3,1”, “3/1”, “-ts=3,1”. */
const TENSOR_SPLIT = /(?:^|\s)(?:-ts|--tensor-split)(?:=|\s+)(\S+)/;

/** A line that can change the placement: avoids rereading the whole ring on every batch of request logs. */
export const RELEVANT = /\[llama-webui\] launch:|using device|buffer size =|offloaded \d+\/\d+ layers|- device \d+:/;

/**
 * Placement of the main model from the last launch found in `lines`; null without a launch line (ring cleared or
 * evicted). llama-server loads the main model (weights, KV cache, compute), then the optional draft (-md), then the
 * mmproj: the second “offloaded N/M layers” opens the draft and ends the parsing. Compute is counted per context
 * (an MTP's adds to the model's) and a context reserved again keeps only its last size.
 * The fitting probes (-fit, visible at -lv 5) come before the load: they are skipped.
 */
export function parsePlacement(lines: readonly LogLine[]): ModelPlacement | null {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.text.startsWith(LAUNCH)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const busIds = new Map<string, string>();
  const buffers = new Map<string, PlacementBuffer>();
  let layers: ModelPlacement['layers'] = null;
  // Compute per context then per device; an implicit first context for logs without “constructing”.
  const contexts: Map<string, number>[] = [new Map()];
  let constructed = false;
  let fitting = false;
  const metaMembers: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const body = lines[i]!.text.replace(PREFIX, '');
    if (FIT_START.test(body)) fitting = true;
    else if (FIT_DONE.test(body)) fitting = false;
    if (fitting) continue;
    if (CONTEXT.test(body)) {
      if (constructed) contexts.push(new Map());
      constructed = true;
      continue;
    }
    if (RESERVE.test(body)) {
      contexts.at(-1)!.clear();
      continue;
    }
    let m = META_MEMBER.exec(body);
    if (m) {
      metaMembers.push(m[1]!);
      continue;
    }
    m = USING.exec(body);
    if (m) {
      busIds.set(m[1]!, m[2]!.toLowerCase());
      continue;
    }
    m = LAYERS.exec(body);
    if (m) {
      if (layers) break;
      layers = { offloaded: Number(m[1]), total: Number(m[2]) };
      continue;
    }
    m = BUFFER.exec(body);
    if (!m || MMPROJ.test(body)) continue;
    const device = m[1]!;
    let b = buffers.get(device);
    if (!b) {
      b = { device, busId: null, modelBytes: 0, kvBytes: 0, computeBytes: 0 };
      buffers.set(device, b);
    }
    const bytes = Number(m[3]) * MiB;
    if (m[2] === 'model') b.modelBytes += bytes;
    else if (m[2] === 'KV' || m[2] === 'RS') b.kvBytes += bytes;
    else {
      const ctx = contexts.at(-1)!;
      ctx.set(device, (ctx.get(device) ?? 0) + bytes);
    }
  }
  for (const ctx of contexts) for (const [device, bytes] of ctx) buffers.get(device)!.computeBytes += bytes;
  for (const b of buffers.values()) b.busId = busIds.get(b.device) ?? null;
  const out = spreadMeta([...buffers.values()], metaMembers, lines[start]!.text, busIds);
  return { launchSeq: lines[start]!.seq, layers, buffers: out };
}

/**
 * With -sm tensor, llama-server logs the buffers of the Meta device that groups the GPUs (`Meta()`), each at the size
 * of its largest per-device part. Each member gets its share: `size × ts[i] / max(ts)` for the model and the cache
 * (equal parts without -ts), the whole compute buffer (each device has its own). These figures are `estimated`.
 */
function spreadMeta(
  buffers: PlacementBuffer[],
  members: string[],
  launch: string,
  busIds: Map<string, string>,
): PlacementBuffer[] {
  const meta = buffers.filter((b) => META.test(b.device));
  if (meta.length === 0 || members.length === 0) return buffers;
  const split = TENSOR_SPLIT.exec(launch)?.[1]?.split(/[,/]/).map(Number) ?? [];
  const weights = members.map((_, i) => {
    const w = split[i];
    return split.length === 0 ? 1 : w !== undefined && Number.isFinite(w) && w >= 0 ? w : 0;
  });
  const max = Math.max(...weights);
  if (!(max > 0)) return buffers;
  const out = buffers.filter((b) => !META.test(b.device));
  members.forEach((device, i) => {
    const share = weights[i]! / max;
    let b = out.find((x) => x.device === device);
    if (!b) {
      b = { device, busId: busIds.get(device) ?? null, modelBytes: 0, kvBytes: 0, computeBytes: 0 };
      out.push(b);
    }
    for (const m of meta) {
      b.modelBytes += m.modelBytes * share;
      b.kvBytes += m.kvBytes * share;
      b.computeBytes += share > 0 ? m.computeBytes : 0;
    }
    b.estimated = true;
  });
  return out;
}

/** Last placement read, with the PID of the server that wrote it. */
export interface PlacementMemory {
  last: { pid: number; placement: ModelPlacement } | null;
}

const g = globalThis as { __llamaWebuiPlacement?: PlacementMemory };
/** Survives `bun --hot`, like the ring: a reload after the launch was evicted keeps the known placement. */
g.__llamaWebuiPlacement ??= { last: null };
const sharedMemory = g.__llamaWebuiPlacement;

export interface PlacementTrackerDeps {
  logs: LogBuffer;
  supervisor: { readonly state: ServerState; subscribe(fn: (s: ServerState) => void): () => void };
  memory?: PlacementMemory;
}

/**
 * Tracks the managed server's placement. Recreated on every Bun reload: it replays the ring (which does survive). The
 * ring only keeps the latest lines: once the launch is evicted (request logs, -lv 4), the last placement read stays
 * valid as long as the tracked server has the same PID. An external server writes nothing to the ring: its
 * placement is unknown even if the ring still holds an old launch.
 */
export class PlacementTracker {
  private _current: ModelPlacement | null = null;
  private serialized = 'null';
  private listeners = new Set<(p: ModelPlacement | null) => void>();
  private unsubs: (() => void)[] = [];

  constructor(private readonly deps: PlacementTrackerDeps) {
    this.recompute();
    this.unsubs.push(
      deps.logs.onLines((lines) => {
        if (lines.some((l) => RELEVANT.test(l.text))) this.recompute();
      }),
      deps.supervisor.subscribe(() => this.recompute()),
    );
  }

  get current(): ModelPlacement | null {
    return this._current;
  }

  onChange(fn: (p: ModelPlacement | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.listeners.clear();
  }

  private placement(): ModelPlacement | null {
    const state = this.deps.supervisor.state;
    const memory = this.deps.memory ?? sharedMemory;
    // Only starting, ready and stopping track a managed server (idle, crashed: none; external: no logs).
    if (state.kind !== 'starting' && state.kind !== 'ready' && state.kind !== 'stopping') {
      memory.last = null;
      return null;
    }
    const parsed = parsePlacement(this.deps.logs.since(0));
    if (parsed) {
      memory.last = { pid: state.pid, placement: parsed };
      return parsed;
    }
    return memory.last?.pid === state.pid ? memory.last.placement : null;
  }

  private recompute(): void {
    const next = this.placement();
    const s = JSON.stringify(next);
    if (s === this.serialized) return;
    this.serialized = s;
    this._current = next;
    for (const fn of this.listeners) fn(next);
  }
}
