import type { BenchDevice, BenchParams, CacheType } from './bench';
import type { CpuInfo } from './monitor';

export type PresetId = 'chat' | 'agent' | 'context' | 'fit' | 'big';

export interface Preset {
  id: PresetId;
  label: string;
  /** One-line explanation. */
  hint: string;
  /** Target context; Infinity = the largest that fits. */
  ctxTarget: number;
  /** The estimate never goes below this. */
  ctxMin: number;
  kvPreferred: 'f16' | 'q8_0';
  ub: number;
  /** Higher = better. */
  score(r: { ppTps: number; tgTps: number; ctx: number }): number;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'chat',
    label: 'Responsive chat',
    hint: 'generation throughput first, 32k context',
    ctxTarget: 32768,
    ctxMin: 8192,
    kvPreferred: 'f16',
    ub: 512,
    score: (r) => r.tgTps,
  },
  {
    id: 'agent',
    label: 'Agent & RAG',
    hint: 'long prompts: prompt processing and generation',
    ctxTarget: 65536,
    ctxMin: 16384,
    kvPreferred: 'q8_0',
    ub: 2048,
    score: (r) => 0.6 * r.ppTps + 0.4 * r.tgTps,
  },
  {
    id: 'context',
    label: 'Max context',
    hint: 'the largest context that fits, then generation',
    ctxTarget: Number.POSITIVE_INFINITY,
    ctxMin: 8192,
    kvPreferred: 'q8_0',
    ub: 512,
    score: (r) => r.ctx * 1e6 + r.tgTps,
  },
  {
    id: 'fit',
    label: 'Make the model fit',
    hint: 'get it to start and reply, even slowly',
    ctxTarget: 8192,
    ctxMin: 8192,
    kvPreferred: 'q8_0',
    ub: 512,
    score: (r) => r.tgTps,
  },
  {
    id: 'big',
    label: '100 GB model',
    hint: 'MoE experts in RAM, attention and norms on all cards',
    ctxTarget: 32768,
    ctxMin: 8192,
    kvPreferred: 'q8_0',
    ub: 512,
    score: (r) => r.tgTps,
  },
];

export const PRESET_IDS = PRESETS.map((p) => p.id) as [PresetId, ...PresetId[]];

export function presetOf(id: PresetId): Preset {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown preset: ${id}`);
  return p;
}

/** llama-bench's relative measurement noise (J5: pp ±8–15% from run to run, tg < 1%). Below it, two configs are a tie. */
export const NOISE = { pp: 0.1, tg: 0.02 } as const;

export type FitVerdict = 'fits' | 'tight' | 'no';

export interface DeviceBudget {
  device: string;
  /** Estimated bytes on the device. */
  bytes: number;
  /** Usable: total minus the margin (CUDA context, fragmentation) and minus `otherBytes`. */
  budget: number;
  totalBytes: number;
  /** VRAM held by other processes than the managed llama-server; missing or 0 when unknown. */
  otherBytes?: number;
}

export interface Fit {
  verdict: FitVerdict;
  vram: DeviceBudget[];
  ramBytes: number;
  ramAvailableBytes: number;
  reason: string | null;
}

export interface TuningHardware {
  devices: BenchDevice[];
  /** Why the device list is not trusted (`--list-devices` crashed…): `devices` is then the last good list, or empty. */
  devicesError?: string | null;
  cpu: CpuInfo;
  ramTotalBytes: number;
  ramAvailableBytes: number;
}

export interface Recommendation {
  flag: string;
  value: string;
  why: string;
}

export interface Estimate {
  ok: boolean;
  reason: string | null;
  preset: PresetId;
  params: BenchParams;
  ctx: number;
  /** K cache type of the configuration (pinned `ctk` included). */
  kv: CacheType;
  /** serverArgs(params) (-t, -b and -ub included), then -c, --fit off, and --mlock and --numa when relevant. */
  serverArgs: string[];
  rows: Recommendation[];
  fit: Fit;
  /** What exceeds the available RAM (re-read from disk through mmap). */
  ramOverflowBytes: number;
  /** Bytes read from disk per generated token when RAM overflows (0 otherwise). */
  diskReadBytesPerToken: number;
  warnings: string[];
}

export interface PlanItem {
  params: BenchParams;
  label: string;
  fit: Fit;
}

export interface PlanResult {
  items: PlanItem[];
  /** Combinations dropped because they do not fit. */
  excluded: number;
  /** (-dev, -ts) pairs discarded for unequal lengths. */
  droppedTs: number;
  estimatedSeconds: number;
}

export type CheckState = 'ok' | 'warn' | 'unknown' | 'na';
export type CheckFamily = 'nvidia' | 'amd' | 'cpu' | 'build' | 'kernel';

export interface Check {
  /** Stable: "nvidia.persistence.<busId>", "cpu.governor"… */
  id: string;
  family: CheckFamily;
  label: string;
  state: CheckState;
  detail: string;
  /** The exact command to run, if there is one. */
  command?: string;
  persistence?: 'session' | 'permanent';
  impact: string;
}

/**
 * Checks that make sense on the first-run checklist: those that need neither a model (memory estimate, model disk)
 * nor a running server (PCIe link under load, `system_info` log line).
 */
const NEEDS_MODEL_OR_SERVER = [
  /^cpu\.(memlock|swappiness)$/,
  /^kernel\.(disk|disk-speed|swap)$/,
  /^(nvidia|amd)\.pcie\./,
  /^build\.simd$/,
];

export const isSetupCheck = (id: string) => !NEEDS_MODEL_OR_SERVER.some((re) => re.test(id));

export interface ChecksReport {
  checks: Check[];
  summary: { warn: number; ok: number; unknown: number; na: number };
  at: number;
}

export interface DiskSpeed {
  bytesPerSec: number;
  sampledBytes: number;
  path: string;
  at: number;
}

/**
 * Native backends first: a card seen by several backends is kept on the best ranked one (CUDA, then ROCm and the
 * other vendor APIs), the Vulkan copy is a `duplicate`.
 */
const BACKEND_RANK: Record<string, number> = { CUDA: 0, ROCm: 1, HIP: 1, MUSA: 1, SYCL: 1, Vulkan: 2 };
const rankOf = (backend: string) => BACKEND_RANK[backend] ?? 3;
/** Vulkan appends the driver: “AMD Radeon RX 9070 XT (RADV GFX1201)”. */
const baseName = (name: string) => name.replace(/\s*\((RADV|AMDVLK|NVK|ANV)[^)]*\)\s*$/i, '').trim();

/**
 * Role of a `--list-devices` device: a dedicated card (`gpu`), the copy of a card already seen through a native
 * backend (`duplicate`: Vulkan next to CUDA or ROCm), an iGPU sharing the RAM (`integrated`) or the host (BLAS, CPU).
 * iGPUs: Vulkan names them after the processor (“AMD Ryzen 5 9600X 6-Core Processor”), ROCm “AMD Radeon Graphics”,
 * with no model number (the desktop Ryzen iGPU; the large APUs, “Radeon 8060S Graphics”, stay usable GPUs).
 */
export function deviceRole(d: BenchDevice, all: BenchDevice[]): 'gpu' | 'duplicate' | 'integrated' | 'host' {
  if (d.backend === 'BLAS' || d.backend === 'CPU' || d.totalMib <= 0) return 'host';
  const name = baseName(d.name);
  if (/processor|\bAPU\b/i.test(name) || /^AMD Radeon(\(TM\))? Graphics$/i.test(name)) return 'integrated';
  const rank = rankOf(d.backend);
  if (all.some((o) => rankOf(o.backend) < rank && o.totalMib > 0 && baseName(o.name) === name)) return 'duplicate';
  return 'gpu';
}

/** Badge shown next to a device that the estimator does not offer (none for a dedicated card). */
export const DEVICE_ROLE_BADGE = { gpu: null, duplicate: 'duplicate', integrated: 'iGPU', host: 'host' } as const;

/** The dedicated cards, in `--list-devices` order: what a missing `-dev` means for the estimate. */
export const gpuDevices = (all: BenchDevice[]): BenchDevice[] => all.filter((d) => deviceRole(d, all) === 'gpu');
