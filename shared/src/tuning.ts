import type { BenchDevice, BenchParams } from './bench';
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
  /** Usable: total minus the margin (CUDA context, fragmentation). */
  budget: number;
  totalBytes: number;
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
  kv: 'f16' | 'q8_0';
  /** serverArgs(params) then -c, -t, -b, -ub, --fit off, --mlock and --numa when relevant. */
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
 * Role of a `--list-devices` device: a dedicated card (`gpu`), the Vulkan copy of a card already seen through CUDA
 * (`duplicate`), an iGPU sharing the RAM (`integrated`: Vulkan named after the processor) or the host (BLAS, CPU).
 */
export function deviceRole(d: BenchDevice, all: BenchDevice[]): 'gpu' | 'duplicate' | 'integrated' | 'host' {
  if (d.backend === 'BLAS' || d.backend === 'CPU' || d.totalMib <= 0) return 'host';
  if (d.backend === 'CUDA') return 'gpu';
  if (/processor|\bAPU\b/i.test(d.name)) return 'integrated';
  if (all.some((o) => o.backend === 'CUDA' && d.name.startsWith(o.name))) return 'duplicate';
  return 'gpu';
}

/** The dedicated cards, in `--list-devices` order: what a missing `-dev` means for the estimate. */
export const gpuDevices = (all: BenchDevice[]): BenchDevice[] => all.filter((d) => deviceRole(d, all) === 'gpu');
