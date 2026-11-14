// The monitoring data, shared by the server and the UI: what a tick reads (GPUs, system, disks, llama-server) and the
// history it appends to. Every number is finite (a reading that is not is sent as null, else as 0): a snapshot with a
// NaN does not encode, and the hub drops a message that does not.

import { Schema, Struct } from 'effect';

/** `/health` of llama-server: 200 → `ok`, 503 → `loading`, another status → `error`, no answer → `down`. */
export const Health = Schema.Literals(['ok', 'loading', 'error', 'down']);
export type Health = typeof Health.Type;

/** One slot of llama-server's `/slots` (the `SlotView` of `llamacpp-js/metrics`). */
export const SlotView = Schema.Struct({
  id: Schema.Int,
  nCtx: Schema.Int,
  processing: Schema.Boolean,
  idTask: Schema.NullOr(Schema.Int),
  nPromptTokens: Schema.Int,
  nPromptProcessed: Schema.Int,
  nDecoded: Schema.Int,
  nRemain: Schema.NullOr(Schema.Int),
});
export type SlotView = typeof SlotView.Type;

/** The rates of the last request, from the `/metrics` counters (the `RequestStats` of `llamacpp-js/metrics`). */
export const RequestStats = Schema.Struct({
  genTps: Schema.NullOr(Schema.Finite),
  ppTps: Schema.NullOr(Schema.Finite),
  specAccept: Schema.NullOr(Schema.Finite),
});
export type RequestStats = typeof RequestStats.Type;

/** Speculative decoding since the start (the `SpecStats` of `llamacpp-js/metrics`). */
export const SpecStats = Schema.Struct({
  acceptCum: Schema.NullOr(Schema.Finite),
  drafts: Schema.Finite,
  draftTokens: Schema.Finite,
  accepted: Schema.Finite,
  meanAcceptedPerDraft: Schema.NullOr(Schema.Finite),
  /** Acceptance rate per draft position. */
  perPos: Schema.Array(Schema.Finite),
});
export type SpecStats = typeof SpecStats.Type;

/** One tick's worth of `/metrics` counter deltas (the `RequestRecord` of `llamacpp-js/metrics`). */
export const RequestRecord = Schema.Struct({
  at: Schema.Int,
  promptTokens: Schema.Finite,
  cachedTokens: Schema.Finite,
  genTokens: Schema.Finite,
  promptSec: Schema.NullOr(Schema.Finite),
  genSec: Schema.NullOr(Schema.Finite),
  ppTps: Schema.NullOr(Schema.Finite),
  genTps: Schema.NullOr(Schema.Finite),
  specAccept: Schema.NullOr(Schema.Finite),
});
export type RequestRecord = typeof RequestRecord.Type;

export { slotContextTokens } from 'llamacpp-js/metrics';

/** A detailed reading: missing or null = unknown (not provided by this vendor or card). */
const Detail = Schema.optionalKey(Schema.NullOr(Schema.Finite));

/** One GPU on one tick. */
export const GpuSample = Schema.Struct({
  /** `nvidia:<uuid>` | `amd:<pdev>`. */
  key: Schema.String,
  vendor: Schema.Literals(['nvidia', 'amd']),
  name: Schema.String,
  /** `0000:01:00.0`. */
  busId: Schema.String,
  utilPct: Schema.NullOr(Schema.Finite),
  vramUsedBytes: Schema.Finite,
  vramTotalBytes: Schema.Finite,
  tempC: Schema.NullOr(Schema.Finite),
  powerW: Schema.NullOr(Schema.Finite),
  /** VRAM held by llama-server on this GPU. */
  procVramBytes: Schema.Finite,
  memUtilPct: Detail,
  fanPct: Detail,
  powerLimitW: Detail,
  /** Factory power limit (NVIDIA); differs from `powerLimitW` if the user lowered it. */
  powerDefaultLimitW: Detail,
  persistence: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  clockGrMhz: Detail,
  clockGrMaxMhz: Detail,
  clockMemMhz: Detail,
  pcieGen: Detail,
  pcieWidth: Detail,
  pcieGenMax: Detail,
  pcieWidthMax: Detail,
  pcieRxBps: Detail,
  pcieTxBps: Detail,
  /** Sleeping card (runtime-suspended), deliberately not read: any read would wake it up. */
  suspended: Schema.optionalKey(Schema.Boolean),
  /** Hidden card (hiddenGpus setting): listed but not read. */
  hidden: Schema.optionalKey(Schema.Boolean),
});
export type GpuSample = typeof GpuSample.Type;

/** What a GPU collector reads: a sample before the VRAM of llama-server's processes is added. */
export const GpuReading = GpuSample.mapFields(Struct.omit(['procVramBytes']));
export type GpuReading = typeof GpuReading.Type;

export const MemInfo = Schema.Struct({
  totalBytes: Schema.Finite,
  availableBytes: Schema.Finite,
  cachedBytes: Schema.Finite,
  swapTotalBytes: Schema.Finite,
  swapUsedBytes: Schema.Finite,
});
export type MemInfo = typeof MemInfo.Type;

/** The machine's DRAM bandwidth (memory controller, via perf): everything that touches RAM, CPU, GPU and NVMe included. */
export const MemBandwidth = Schema.Struct({ readBps: Schema.Finite, writeBps: Schema.Finite });
export type MemBandwidth = typeof MemBandwidth.Type;

export const SystemSample = Schema.Struct({
  cpuPct: Schema.Finite,
  corePct: Schema.Array(Schema.Finite),
  freqMhz: Schema.NullOr(Schema.Finite),
  tempC: Schema.NullOr(Schema.Finite),
  /** Load average over 1, 5 and 15 minutes. */
  load: Schema.NullOr(Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite])),
  mem: Schema.NullOr(MemInfo),
  /** Missing or null: not measurable (no perf, unknown PMU, permissions). */
  memBw: Schema.optionalKey(Schema.NullOr(MemBandwidth)),
});
export type SystemSample = typeof SystemSample.Type;

export const DiskRates = Schema.Struct({ readBps: Schema.Finite, writeBps: Schema.Finite });
export type DiskRates = typeof DiskRates.Type;

/** The machine's physical disks: their total, each one (by block name, `nvme0n1`) and the model's. */
export const DiskSample = Schema.Struct({
  ...DiskRates.fields,
  perDisk: Schema.Record(Schema.String, DiskRates),
  model: Schema.NullOr(Schema.Struct({ disk: Schema.String, readBps: Schema.Finite })),
});
export type DiskSample = typeof DiskSample.Type;

export const CpuInfo = Schema.Struct({
  model: Schema.String,
  physicalCores: Schema.Int,
  logicalThreads: Schema.Int,
  flags: Schema.Array(Schema.String),
  numaNodes: Schema.Int,
});
export type CpuInfo = typeof CpuInfo.Type;

/** Keys of the history series. */
export const SERIES = {
  genTps: 'llama.genTps',
  ppTps: 'llama.ppTps',
  specAccept: 'llama.specAccept',
  cpuPct: 'proc.cpuPct',
  gpuUtil: (gpuKey: string) => `gpu.${gpuKey}.util`,
  gpuVramPct: (gpuKey: string) => `gpu.${gpuKey}.vramPct`,
  gpuPcieRx: (gpuKey: string) => `gpu.${gpuKey}.pcieRx`,
  gpuPcieTx: (gpuKey: string) => `gpu.${gpuKey}.pcieTx`,
  gpuPower: (gpuKey: string) => `gpu.${gpuKey}.power`,
  gpuTemp: (gpuKey: string) => `gpu.${gpuKey}.temp`,
  sysCpu: 'sys.cpu',
  sysMemPct: 'sys.memPct',
  sysTemp: 'sys.tempC',
  memRead: 'mem.read',
  memWrite: 'mem.write',
  procDram: 'proc.dram',
  diskRead: 'disk.read',
  diskWrite: 'disk.write',
  modelDiskRead: 'disk.modelRead',
  kvPct: 'llama.kvPct',
  reqProcessing: 'llama.reqProcessing',
  reqDeferred: 'llama.reqDeferred',
  busySlots: 'llama.busySlots',
} as const;

/** Monitoring state pushed on every tick over the WebSocket. */
export const Snapshot = Schema.Struct({
  at: Schema.Int,
  tick: Schema.Int,
  /** null: no active server. */
  health: Schema.NullOr(Health),
  rates: Schema.Struct({ genTps: Schema.Finite, ppTps: Schema.Finite }),
  slots: Schema.NullOr(Schema.Array(SlotView)),
  kv: Schema.NullOr(Schema.Struct({ usedTokens: Schema.Int, totalTokens: Schema.Int })),
  /** `busySlots`: busy slots per llama_decode() call, an average (`llamacpp:n_busy_slots_per_decode`), so fractional. */
  queue: Schema.NullOr(Schema.Struct({ processing: Schema.Int, deferred: Schema.Int, busySlots: Schema.Finite })),
  lastRequest: Schema.NullOr(RequestStats),
  spec: Schema.NullOr(SpecStats),
  /** Most recent first. */
  recentRequests: Schema.Array(RequestRecord),
  /** GPUs used by the server (VRAM > 64 MiB). */
  gpus: Schema.Array(GpuSample),
  /** All GPUs, sorted by busId, hidden and sleeping ones included (not read). */
  allGpus: Schema.Array(GpuSample),
  /** `dramBps`: bytes/s fetched from DRAM by llama-server (perf, core event); missing or null = unknown. */
  proc: Schema.NullOr(
    Schema.Struct({
      cpuPct: Schema.Finite,
      rssBytes: Schema.Finite,
      dramBps: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
    }),
  ),
  system: Schema.NullOr(SystemSample),
  disk: Schema.NullOr(DiskSample),
  /** Values appended to the history on this tick, by `SERIES` key (null = gap). */
  points: Schema.Record(Schema.String, Schema.NullOr(Schema.Finite)),
  /** Shape of the history: a change (settings) invalidates the client's copy. */
  history: Schema.Struct({ intervalMs: Schema.Int, capacity: Schema.Int }),
});
export type Snapshot = typeof Snapshot.Type;

/** Full history: one value per tick, oldest first, `null` = gap. */
export const HistoryDump = Schema.Struct({
  intervalMs: Schema.Int,
  capacity: Schema.Int,
  /** Time of the last point. */
  at: Schema.Int,
  /** Time of each point (ms), same length as each series. */
  times: Schema.Array(Schema.Int),
  series: Schema.Record(Schema.String, Schema.Array(Schema.NullOr(Schema.Finite))),
});
export type HistoryDump = typeof HistoryDump.Type;

/** Where the NVIDIA GPUs are read from: the NVML library, else the `nvidia-smi` program. */
export const NvidiaSource = Schema.Literals(['nvml', 'nvidia-smi']);
export type NvidiaSource = typeof NvidiaSource.Type;

/** The machine as the System page shows it: its CPU, every GPU (hidden and sleeping ones included), the NVIDIA source. */
export const SystemInfo = Schema.Struct({
  cpu: CpuInfo,
  gpus: Schema.Array(GpuSample.mapFields(Struct.pick(['key', 'name', 'vendor', 'busId', 'vramTotalBytes']))),
  nvidiaSource: NvidiaSource,
});
export type SystemInfo = typeof SystemInfo.Type;
