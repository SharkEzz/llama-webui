import {
  type BenchDevice,
  type BenchParams,
  deviceRole,
  type Fit,
  fmtBytes,
  gpuDevices,
  MiB,
} from '@llama-webui/shared';
import { Array as Arr, Number as Num, Option, Predicate, String as Str } from 'effect';
import type { ModelInfo } from '../models/gguf.ts';
import { EXPERTS } from '../models/sizes.ts';
import { budgetBytes, computeBytes, type KvTypes, kvLayerBytes, recurrentBytes } from './memory.ts';

export interface PlacementInput {
  readonly model: ModelInfo;
  /** All devices from `--list-devices` (`-dev`, `-ot` and the automatic `-dev` are resolved against them). */
  readonly devices: ReadonlyArray<BenchDevice>;
  readonly params: BenchParams;
  readonly ctx: number;
  readonly kv: KvTypes;
  readonly ub: number;
  readonly mmprojBytes: number;
  readonly ramAvailableBytes: number;
}

export interface PlacementMeasure {
  /** Selected devices, in order (the first one gets the compute buffers). */
  readonly used: ReadonlyArray<string>;
  /** Bytes per device (weights, KV, buffers), in order of appearance. */
  readonly vram: ReadonlyMap<string, number>;
  /** Bytes in RAM (weights on CPU, KV of CPU layers). */
  readonly ram: number;
  /** Device of each repeating layer ("CPU" if it is not offloaded). */
  readonly layerDevice: ReadonlyArray<string>;
  readonly cpuWeights: number;
  readonly cpuExpertsBytes: number;
  readonly cpuOtherBytes: number;
  readonly gpuWeights: number;
  /** -dev or -ot targeting an unknown device, invalid -ot pattern. */
  readonly issues: ReadonlyArray<string>;
}

const LAYER = /^blk\.(\d+)\./;
const CPU = 'CPU';

/** -ngl as a layer count (repeating + output): missing, `all` or `auto` = everything (llama-bench: -1, llama-server: --fit). */
const nglOf = (p: BenchParams, layers: number): number => (Predicate.isNumber(p.ngl) ? p.ngl : layers + 1);

const UNKNOWN_DEVICE = 'unknown device';
/** Host buffer types an `-ot` rule may name: `CPU`, `CPU_REPACK`, `CUDA_Host`… (RAM). */
const HOST_BUFFER = /^CPU(?:_|$)|_Host$/i;

interface Rule {
  readonly re: RegExp;
  readonly target: string;
}

const compile = (pattern: string): Option.Option<RegExp> => {
  try {
    return Option.some(new RegExp(pattern));
  } catch {
    return Option.none();
  }
};

/**
 * The `-ot` rules in order: the first matching pattern wins, as in llama.cpp. A target is a listed device or a host
 * buffer (RAM); anything else is an unknown device (#36): reported, and counted in RAM as llama.cpp would fail anyway.
 */
const overrides = (p: BenchParams, known: ReadonlySet<string>, issues: Array<string>): Array<Rule> => {
  const out: Array<Rule> = [];
  for (const rule of p.ot ?? []) {
    const eq = Option.getOrElse(Str.lastIndexOf('=')(rule), () => -1);
    const pattern = Str.slice(0, eq)(rule);
    const target = Str.slice(eq + 1)(rule);
    const re = compile(pattern);
    if (Option.isNone(re)) {
      issues.push(`invalid -ot pattern: ${pattern}`);
      continue;
    }
    out.push({ re: re.value, target: known.has(target) ? target : CPU });
    if (!known.has(target) && !HOST_BUFFER.test(target)) issues.push(`${UNKNOWN_DEVICE}: ${target} (-ot ${rule})`);
  }
  return out;
};

/** The devices of `-dev` (an unknown or host one is an issue, `none` is skipped), or the dedicated cards without it. */
const usedDevices = (
  params: BenchParams,
  devices: ReadonlyArray<BenchDevice>,
  issues: Array<string>,
): Array<BenchDevice> => {
  if (params.dev === undefined) return gpuDevices(devices);
  const used: Array<BenchDevice> = [];
  for (const id of params.dev) {
    const d = Arr.findFirst(devices, (x) => x.id === id);
    if (Option.isSome(d) && deviceRole(d.value, devices) !== 'host') used.push(d.value);
    else if (id !== 'none') issues.push(`${UNKNOWN_DEVICE}: ${id}`);
  }
  return used;
};

/** Assigns each GGUF tensor to a device or RAM according to the flags, then adds KV, buffers and projector. */
export const measurePlacement = (input: PlacementInput): PlacementMeasure => {
  const { model, params } = input;
  const issues: Array<string> = [];
  const byId = new Map(Arr.map(input.devices, (d) => [d.id, d] as const));
  const used = usedDevices(params, input.devices, issues);
  const L = model.blockCount;
  const ngl = Arr.isReadonlyArrayNonEmpty(used) ? nglOf(params, L) : 0;
  const gpuLayers = Math.min(ngl, L);
  const start = L - gpuLayers;
  const outputOnGpu = Arr.isReadonlyArrayNonEmpty(used) && ngl > L;

  // Contiguous slices proportional to -ts (otherwise to free VRAM, as in llama.cpp), in -dev order.
  const ts =
    params.ts !== undefined && params.ts.length === used.length && Arr.some(params.ts, (x) => x > 0)
      ? params.ts
      : Arr.map(used, (d) => (d.freeMib !== 0 ? d.freeMib : d.totalMib));
  const sum = Num.sumAll(ts);
  let acc = 0;
  const cum = Arr.map(ts, (x) => {
    acc += x;
    return acc / sum;
  });
  const deviceAt = (i: number): string => {
    const first = Arr.head(used);
    if (Option.isNone(first) || i < start) return CPU;
    if (params.sm === 'none' || used.length === 1) return first.value.id;
    const frac = (i - start) / Math.max(1, gpuLayers);
    const j = Option.getOrElse(
      Arr.findFirstIndex(cum, (c) => frac < c),
      () => used.length - 1,
    );
    return Option.getOrElse(
      Option.map(Arr.get(used, j), (d) => d.id),
      () => CPU,
    );
  };
  const layerDevice: Array<string> = [];
  for (let i = 0; i < L; i++) layerDevice.push(deviceAt(i));
  const lastDevice = Option.getOrElse(
    Option.map(Arr.last(used), (d) => d.id),
    () => CPU,
  );
  const rules = overrides(params, new Set(byId.keys()), issues);
  const ncmoe = params.ncmoe ?? 0;

  const vram = new Map<string, number>(Arr.map(used, (d) => [d.id, 0] as const));
  const add = (where: string, bytes: number): void => {
    if (where === CPU) return;
    const before = vram.get(where);
    if (before === undefined && !byId.has(where)) issues.push(`${UNKNOWN_DEVICE}: ${where}`);
    vram.set(where, (before ?? 0) + bytes);
  };
  let ram = 0;
  let cpuWeights = 0;
  let cpuExpertsBytes = 0;
  let cpuOtherBytes = 0;
  let gpuWeights = 0;
  const offOutput = outputOnGpu ? lastDevice : CPU;
  for (const t of model.tensors) {
    const layer = Option.map(Option.fromNullishOr(LAYER.exec(t.name)), (m) => Number(m[1]));
    const rule = Arr.findFirst(rules, (r) => r.re.test(t.name));
    const target = Option.isSome(rule)
      ? rule.value.target
      : Option.isSome(layer) && layer.value < ncmoe && EXPERTS.test(t.name)
        ? CPU
        : Str.startsWith('token_embd.')(t.name)
          ? CPU
          : Option.isSome(layer)
            ? (layerDevice[layer.value] ?? offOutput)
            : offOutput;
    if (target === CPU) {
      ram += t.bytes;
      cpuWeights += t.bytes;
      if (EXPERTS.test(t.name)) cpuExpertsBytes += t.bytes;
      else if (Option.isSome(layer)) cpuOtherBytes += t.bytes;
    } else {
      add(target, t.bytes);
      gpuWeights += t.bytes;
    }
  }
  for (let i = 0; i < L; i++) {
    const kv = kvLayerBytes(model, { layer: i, ctx: input.ctx, kv: input.kv });
    const where = layerDevice[i] ?? CPU;
    if (where === CPU) ram += kv;
    else add(where, kv);
  }
  const extras = computeBytes(model, input.ub) + input.mmprojBytes + recurrentBytes(model);
  const main = Arr.head(used);
  if (Option.isSome(main) && gpuLayers > 0) add(main.value.id, extras);
  else ram += extras;
  return {
    used: Arr.map(used, (d) => d.id),
    vram,
    ram,
    layerDevice,
    cpuWeights,
    cpuExpertsBytes,
    cpuOtherBytes,
    gpuWeights,
    issues: Arr.dedupe(issues),
  };
};

const MIN_FREE_RATIO = 0.95;

/**
 * `fits`: every device under 95% of its budget (total − margin − other processes) and enough RAM; `tight`: under
 * budget, or RAM exceeded (mmap re-reads the rest from disk: slow, not a failure); otherwise `no`. `measured` is
 * measured from the input when it is not given.
 */
export const fitOf = (input: PlacementInput & { readonly measured?: PlacementMeasure }): Fit => {
  const measured = input.measured ?? measurePlacement(input);
  const byId = new Map(Arr.map(input.devices, (d) => [d.id, d] as const));
  const vram = Arr.map(Arr.fromIterable(measured.vram), ([device, bytes]) => {
    const d = byId.get(device);
    return {
      device,
      bytes,
      totalBytes: (d?.totalMib ?? 0) * MiB,
      budget: d === undefined ? 0 : budgetBytes(d),
      otherBytes: (d?.otherUsedMib ?? 0) * MiB,
    };
  });
  const base = { vram, ramBytes: measured.ram, ramAvailableBytes: input.ramAvailableBytes };
  const unknown = Arr.findFirst(measured.issues, Str.startsWith(UNKNOWN_DEVICE));
  if (Option.isSome(unknown)) return { ...base, verdict: 'no', reason: unknown.value };
  const over = Arr.findFirst(vram, (v) => v.bytes > v.budget);
  if (Option.isSome(over))
    return {
      ...base,
      verdict: 'no',
      reason: `${over.value.device}: ${fmtBytes(over.value.bytes)} for ${fmtBytes(over.value.budget)} usable`,
    };
  if (measured.ram > input.ramAvailableBytes)
    return {
      ...base,
      verdict: 'tight',
      reason: `RAM: ${fmtBytes(measured.ram)} for ${fmtBytes(input.ramAvailableBytes)} available, the rest is re-read from disk`,
    };
  const near = Arr.findFirst(vram, (v) => v.bytes > MIN_FREE_RATIO * v.budget);
  if (Option.isSome(near))
    return {
      ...base,
      verdict: 'tight',
      reason: `${near.value.device}: ${fmtBytes(near.value.bytes)} for ${fmtBytes(near.value.budget)} usable, thin margin`,
    };
  return { ...base, verdict: 'fits', reason: null };
};
