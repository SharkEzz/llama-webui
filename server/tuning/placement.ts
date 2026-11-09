import {
  type BenchDevice,
  type BenchParams,
  type CacheType,
  deviceRole,
  type Fit,
  gpuDevices,
} from '@llama-webui/shared';
import type { ModelInfo } from '../models/gguf';
import { EXPERTS } from '../models/sizes';
import { budgetBytes, computeBytes, fmtBytes, kvLayerBytes, MiB, recurrentBytes } from './memory';

export interface PlacementInput {
  model: ModelInfo;
  /** All devices from `--list-devices` (`-dev`, `-ot` and the automatic `-dev` are resolved against them). */
  devices: BenchDevice[];
  params: BenchParams;
  ctx: number;
  kv: { k: CacheType; v: CacheType };
  ub: number;
  mmprojBytes: number;
  ramAvailableBytes: number;
}

export interface PlacementMeasure {
  /** Selected devices, in order (the first one gets the compute buffers). */
  used: string[];
  /** Bytes per device (weights, KV, buffers), in order of appearance. */
  vram: Map<string, number>;
  /** Bytes in RAM (weights on CPU, KV of CPU layers). */
  ram: number;
  /** Device of each repeating layer ("CPU" if it is not offloaded). */
  layerDevice: string[];
  cpuWeights: number;
  cpuExpertsBytes: number;
  cpuOtherBytes: number;
  gpuWeights: number;
  /** -dev or -ot targeting an unknown device, invalid -ot pattern. */
  issues: string[];
}

const LAYER = /^blk\.(\d+)\./;
const CPU = 'CPU';

/** -ngl as a layer count (repeating + output): missing, `all` or `auto` = everything (llama-bench: -1, llama-server: --fit). */
function nglOf(p: BenchParams, layers: number): number {
  return typeof p.ngl === 'number' ? p.ngl : layers + 1;
}

/** The `-ot` rules in order: the first matching pattern wins, as in llama.cpp. */
function overrides(p: BenchParams, issues: string[]): { re: RegExp; target: string }[] {
  const out: { re: RegExp; target: string }[] = [];
  for (const rule of p.ot ?? []) {
    const eq = rule.lastIndexOf('=');
    try {
      out.push({ re: new RegExp(rule.slice(0, eq)), target: rule.slice(eq + 1) });
    } catch {
      issues.push(`invalid -ot pattern: ${rule.slice(0, eq)}`);
    }
  }
  return out;
}

const UNKNOWN_DEVICE = 'unknown device';

/** Assigns each GGUF tensor to a device or RAM according to the flags, then adds KV, buffers and projector. */
export function measurePlacement(input: PlacementInput): PlacementMeasure {
  const { model, params } = input;
  const issues: string[] = [];
  const byId = new Map(input.devices.map((d) => [d.id, d]));
  let used: BenchDevice[];
  if (params.dev) {
    used = [];
    for (const id of params.dev) {
      const d = byId.get(id);
      if (d && deviceRole(d, input.devices) !== 'host') used.push(d);
      else if (id !== 'none') issues.push(`${UNKNOWN_DEVICE}: ${id}`);
    }
  } else used = gpuDevices(input.devices);
  const L = model.blockCount;
  const ngl = used.length === 0 ? 0 : nglOf(params, L);
  const gpuLayers = Math.min(ngl, L);
  const start = L - gpuLayers;
  const outputOnGpu = used.length > 0 && ngl > L;

  // Contiguous slices proportional to -ts (otherwise to free VRAM, as in llama.cpp), in -dev order.
  const ts =
    params.ts && params.ts.length === used.length && params.ts.some((x) => x > 0)
      ? params.ts
      : used.map((d) => d.freeMib || d.totalMib);
  const sum = ts.reduce((a, b) => a + b, 0);
  let acc = 0;
  const cum = ts.map((x) => {
    acc += x;
    return acc / sum;
  });
  const deviceAt = (i: number): string => {
    if (used.length === 0 || i < start) return CPU;
    if (params.sm === 'none' || used.length === 1) return used[0]!.id;
    const frac = (i - start) / Math.max(1, gpuLayers);
    const j = cum.findIndex((c) => frac < c);
    return used[j === -1 ? used.length - 1 : j]!.id;
  };
  const layerDevice = Array.from({ length: L }, (_, i) => deviceAt(i));
  const lastDevice = used.at(-1)?.id ?? CPU;
  const rules = overrides(params, issues);
  const ncmoe = params.ncmoe ?? 0;

  const vram = new Map<string, number>(used.map((d) => [d.id, 0]));
  const add = (where: string, bytes: number) => {
    if (where === CPU) return;
    if (!vram.has(where)) {
      if (!byId.has(where)) issues.push(`${UNKNOWN_DEVICE}: ${where}`);
      vram.set(where, 0);
    }
    vram.set(where, vram.get(where)! + bytes);
  };
  let ram = 0;
  let cpuWeights = 0;
  let cpuExpertsBytes = 0;
  let cpuOtherBytes = 0;
  let gpuWeights = 0;
  for (const t of model.tensors) {
    const m = LAYER.exec(t.name);
    const layer = m ? Number(m[1]) : null;
    let target: string;
    const rule = rules.find((r) => r.re.test(t.name));
    if (rule) target = byId.has(rule.target) ? rule.target : CPU;
    else if (layer !== null && layer < ncmoe && EXPERTS.test(t.name)) target = CPU;
    else if (t.name.startsWith('token_embd.')) target = CPU;
    else if (layer !== null) target = layerDevice[layer] ?? (outputOnGpu ? lastDevice : CPU);
    else target = outputOnGpu ? lastDevice : CPU;
    if (target === CPU) {
      ram += t.bytes;
      cpuWeights += t.bytes;
      if (EXPERTS.test(t.name)) cpuExpertsBytes += t.bytes;
      else if (layer !== null) cpuOtherBytes += t.bytes;
    } else {
      add(target, t.bytes);
      gpuWeights += t.bytes;
    }
  }
  for (let i = 0; i < L; i++) {
    const kv = kvLayerBytes(model, i, input.ctx, input.kv);
    if (layerDevice[i] === CPU) ram += kv;
    else add(layerDevice[i]!, kv);
  }
  const extras = computeBytes(model, input.ub) + input.mmprojBytes + recurrentBytes(model);
  if (used.length > 0 && gpuLayers > 0) add(used[0]!.id, extras);
  else ram += extras;
  return {
    used: used.map((d) => d.id),
    vram,
    ram,
    layerDevice,
    cpuWeights,
    cpuExpertsBytes,
    cpuOtherBytes,
    gpuWeights,
    issues: [...new Set(issues)],
  };
}

const MIN_FREE_RATIO = 0.95;

/**
 * `fits`: every device under 95% of its budget (total − margin − other processes) and enough RAM; `tight`: under budget, or RAM exceeded
 * (mmap re-reads the rest from disk: slow, not a failure); otherwise `no`.
 */
export function fitOf(input: PlacementInput, measured: PlacementMeasure = measurePlacement(input)): Fit {
  const byId = new Map(input.devices.map((d) => [d.id, d]));
  const vram = [...measured.vram].map(([device, bytes]) => {
    const d = byId.get(device);
    const otherBytes = (d?.otherUsedMib ?? 0) * MiB;
    return { device, bytes, totalBytes: (d?.totalMib ?? 0) * MiB, budget: d ? budgetBytes(d) : 0, otherBytes };
  });
  const base = { vram, ramBytes: measured.ram, ramAvailableBytes: input.ramAvailableBytes };
  const unknown = measured.issues.find((i) => i.startsWith(UNKNOWN_DEVICE));
  if (unknown) return { ...base, verdict: 'no', reason: unknown };
  const over = vram.find((v) => v.bytes > v.budget);
  if (over)
    return {
      ...base,
      verdict: 'no',
      reason: `${over.device}: ${fmtBytes(over.bytes)} for ${fmtBytes(over.budget)} usable`,
    };
  const near = vram.find((v) => v.bytes > MIN_FREE_RATIO * v.budget);
  if (measured.ram > input.ramAvailableBytes)
    return {
      ...base,
      verdict: 'tight',
      reason: `RAM: ${fmtBytes(measured.ram)} for ${fmtBytes(input.ramAvailableBytes)} available, the rest is re-read from disk`,
    };
  if (near)
    return {
      ...base,
      verdict: 'tight',
      reason: `${near.device}: ${fmtBytes(near.bytes)} for ${fmtBytes(near.budget)} usable, thin margin`,
    };
  return { ...base, verdict: 'fits', reason: null };
}
