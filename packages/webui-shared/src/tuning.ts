import { Array as Arr, Option, Schema, String as Str } from 'effect';
import { dual } from 'effect/Function';
import { BenchDevice, BenchParams, CACHE_TYPES } from './bench.ts';
import { CpuInfo } from './monitor.ts';

export const PRESET_IDS = ['chat', 'agent', 'context', 'fit', 'big'] as const;
export const PresetId = Schema.Literals(PRESET_IDS);
export type PresetId = typeof PresetId.Type;

export interface Preset {
  readonly id: PresetId;
  readonly label: string;
  /** One-line explanation. */
  readonly hint: string;
  /** Target context; Infinity = the largest that fits. */
  readonly ctxTarget: number;
  /** The estimate never goes below this. */
  readonly ctxMin: number;
  readonly kvPreferred: 'f16' | 'q8_0';
  readonly ub: number;
  /** Higher = better. */
  readonly score: (r: { readonly ppTps: number; readonly tgTps: number; readonly ctx: number }) => number;
}

export const PRESETS: ReadonlyArray<Preset> = [
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

/** The preset of an id (every id of `PresetId` has one). */
export const presetOf = (id: PresetId): Preset =>
  Option.getOrThrowWith(
    Arr.findFirst(PRESETS, (p) => p.id === id),
    () => new Error(`unknown preset: ${id}`),
  );

/** llama-bench's relative measurement noise (J5: pp ±8–15% from run to run, tg < 1%). Below it, two configs are a tie. */
export const NOISE = { pp: 0.1, tg: 0.02 } as const;

export const FitVerdict = Schema.Literals(['fits', 'tight', 'no']);
export type FitVerdict = typeof FitVerdict.Type;

export const DeviceBudget = Schema.Struct({
  device: Schema.String,
  /** Estimated bytes on the device. */
  bytes: Schema.Finite,
  /** Usable: total minus the margin (CUDA context, fragmentation) and minus `otherBytes`. */
  budget: Schema.Finite,
  totalBytes: Schema.Finite,
  /** VRAM held by other processes than the managed llama-server; missing or 0 when unknown. */
  otherBytes: Schema.optionalKey(Schema.Finite),
});
export type DeviceBudget = typeof DeviceBudget.Type;

export const Fit = Schema.Struct({
  verdict: FitVerdict,
  vram: Schema.Array(DeviceBudget),
  ramBytes: Schema.Finite,
  ramAvailableBytes: Schema.Finite,
  reason: Schema.NullOr(Schema.String),
});
export type Fit = typeof Fit.Type;

/** What the estimator plans on: the devices llama-bench lists, with their live memory, the CPU and the RAM. */
export const TuningHardware = Schema.Struct({
  devices: Schema.Array(BenchDevice),
  /** Why the device list is not trusted (`--list-devices` crashed…): `devices` is then the last good list, or empty. */
  devicesError: Schema.NullOr(Schema.String),
  cpu: CpuInfo,
  ramTotalBytes: Schema.Finite,
  ramAvailableBytes: Schema.Finite,
});
export type TuningHardware = typeof TuningHardware.Type;

export const Recommendation = Schema.Struct({ flag: Schema.String, value: Schema.String, why: Schema.String });
export type Recommendation = typeof Recommendation.Type;

export const Estimate = Schema.Struct({
  ok: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  preset: PresetId,
  params: BenchParams,
  ctx: Schema.Int,
  /** K cache type of the configuration (pinned `ctk` included). */
  kv: Schema.Literals(CACHE_TYPES),
  /** serverArgs(params) (-t, -b and -ub included), then -c, --fit off, and --load-mode mmap+mlock and --numa when relevant. */
  serverArgs: Schema.Array(Schema.String),
  rows: Schema.Array(Recommendation),
  fit: Fit,
  /** What exceeds the available RAM (re-read from disk through mmap). */
  ramOverflowBytes: Schema.Finite,
  /** Bytes read from disk per generated token when RAM overflows (0 otherwise). */
  diskReadBytesPerToken: Schema.Finite,
  warnings: Schema.Array(Schema.String),
});
export type Estimate = typeof Estimate.Type;

export const PlanItem = Schema.Struct({ params: BenchParams, label: Schema.String, fit: Fit });
export type PlanItem = typeof PlanItem.Type;

export const PlanResult = Schema.Struct({
  items: Schema.Array(PlanItem),
  /** Combinations dropped because they do not fit. */
  excluded: Schema.Int,
  /** (-dev, -ts) pairs discarded for unequal lengths. */
  droppedTs: Schema.Int,
  estimatedSeconds: Schema.Int,
});
export type PlanResult = typeof PlanResult.Type;

export const CheckState = Schema.Literals(['ok', 'warn', 'unknown', 'na']);
export type CheckState = typeof CheckState.Type;
export const CheckFamily = Schema.Literals(['nvidia', 'amd', 'cpu', 'build', 'kernel']);
export type CheckFamily = typeof CheckFamily.Type;

export const Check = Schema.Struct({
  /** Stable: "nvidia.persistence.<busId>", "cpu.governor"… */
  id: Schema.String,
  family: CheckFamily,
  label: Schema.String,
  state: CheckState,
  detail: Schema.String,
  /** The exact command to run, if there is one. */
  command: Schema.optionalKey(Schema.String),
  persistence: Schema.optionalKey(Schema.Literals(['session', 'permanent'])),
  impact: Schema.String,
});
export type Check = typeof Check.Type;

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

export const isSetupCheck = (id: string): boolean => !Arr.some(NEEDS_MODEL_OR_SERVER, (re) => re.test(id));

export const CheckSummary = Schema.Struct({ warn: Schema.Int, ok: Schema.Int, unknown: Schema.Int, na: Schema.Int });
export type CheckSummary = typeof CheckSummary.Type;

export const ChecksReport = Schema.Struct({
  checks: Schema.Array(Check),
  summary: CheckSummary,
  at: Schema.Int,
});
export type ChecksReport = typeof ChecksReport.Type;

export const DiskSpeed = Schema.Struct({
  bytesPerSec: Schema.Finite,
  sampledBytes: Schema.Int,
  path: Schema.String,
  at: Schema.Int,
});
export type DiskSpeed = typeof DiskSpeed.Type;

/** A non-empty path, as the tuning requests take it. */
const ModelPath = Schema.String.check(Schema.isMinLength(1, { message: 'cannot be empty' }));

/** `POST /api/tuning/estimate` (strict). */
export const EstimateRequest = Schema.Struct({
  modelPath: ModelPath,
  mmprojPath: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
  preset: PresetId,
  pinned: Schema.optionalKey(BenchParams),
  ctx: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(512, { message: 'at least 512' }),
      Schema.isLessThanOrEqualTo(10_000_000, { message: 'at most 10000000' }),
    ),
  ),
}).annotate({ messageUnexpectedKey: 'unknown key' });
export type EstimateRequest = typeof EstimateRequest.Type;

/** `POST /api/tuning/disk-speed` (strict). */
export const DiskSpeedRequest = Schema.Struct({ modelPath: ModelPath }).annotate({
  messageUnexpectedKey: 'unknown key',
});

/**
 * Native backends first: a card seen by several backends is kept on the best ranked one (CUDA, then ROCm and the
 * other vendor APIs), the Vulkan copy is a `duplicate`.
 */
const BACKEND_RANK: Readonly<Record<string, number>> = { CUDA: 0, ROCm: 1, HIP: 1, MUSA: 1, SYCL: 1, Vulkan: 2 };
const rankOf = (backend: string): number => BACKEND_RANK[backend] ?? 3;
/** Vulkan appends the driver: “AMD Radeon RX 9070 XT (RADV GFX1201)”. */
export const baseName = (name: string): string =>
  Str.trim(Str.replace(/\s*\((RADV|AMDVLK|NVK|ANV)[^)]*\)\s*$/i, '')(name));

/**
 * Role of a `--list-devices` device: a dedicated card (`gpu`), the copy of a card already seen through a native
 * backend (`duplicate`: Vulkan next to CUDA or ROCm), an iGPU sharing the RAM (`integrated`) or the host (BLAS, CPU).
 * iGPUs: Vulkan names them after the processor (“AMD Ryzen 5 9600X 6-Core Processor”), ROCm “AMD Radeon Graphics”,
 * with no model number (the desktop Ryzen iGPU; the large APUs, “Radeon 8060S Graphics”, stay usable GPUs).
 */
export type DeviceRole = 'gpu' | 'duplicate' | 'integrated' | 'host';

export const deviceRole: {
  (all: ReadonlyArray<BenchDevice>): (d: BenchDevice) => DeviceRole;
  (d: BenchDevice, all: ReadonlyArray<BenchDevice>): DeviceRole;
} = dual(2, (d: BenchDevice, all: ReadonlyArray<BenchDevice>): DeviceRole => {
  if (d.backend === 'BLAS' || d.backend === 'CPU' || d.totalMib <= 0) return 'host';
  const name = baseName(d.name);
  if (/processor|\bAPU\b/i.test(name) || /^AMD Radeon(\(TM\))? Graphics$/i.test(name)) return 'integrated';
  const rank = rankOf(d.backend);
  if (Arr.some(all, (o) => rankOf(o.backend) < rank && o.totalMib > 0 && baseName(o.name) === name)) return 'duplicate';
  return 'gpu';
});

/** Badge shown next to a device that the estimator does not offer (none for a dedicated card). */
export const DEVICE_ROLE_BADGE = { gpu: null, duplicate: 'duplicate', integrated: 'iGPU', host: 'host' } as const;

/** The dedicated cards, in `--list-devices` order: what a missing `-dev` means for the estimate. */
export const gpuDevices = (all: ReadonlyArray<BenchDevice>): Array<BenchDevice> =>
  Arr.filter(all, (d) => deviceRole(d, all) === 'gpu');
