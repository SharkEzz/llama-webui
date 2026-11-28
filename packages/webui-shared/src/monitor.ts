// The monitoring data, shared by the server and the UI: what a tick reads (GPUs, system, disks, llama-server) and the
// history it appends to. Every number is finite (a reading that is not is sent as null, else as 0): a snapshot with a
// NaN does not encode, and the hub drops a message that does not.

import { Schema, Struct } from 'effect';

/** `/health` of llama-server: 200 → `ok`, 503 → `loading`, another status → `error`, no answer → `down`. */
export const Health = Schema.Literals(['ok', 'loading', 'error', 'down']).annotate({
  identifier: 'LlamaHealth',
  description: 'Health state polled from llama-server /health.',
});
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
}).annotate({ identifier: 'SlotView', description: 'One inference slot read from llama-server /slots.' });
export type SlotView = typeof SlotView.Type;

/** The rates of the last request, from the `/metrics` counters (the `RequestStats` of `llamacpp-js/metrics`). */
export const RequestStats = Schema.Struct({
  genTps: Schema.NullOr(Schema.Finite),
  ppTps: Schema.NullOr(Schema.Finite),
  specAccept: Schema.NullOr(Schema.Finite),
}).annotate({
  identifier: 'RequestStats',
  description: 'Throughput rates computed from llama-server /metrics counters.',
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
}).annotate({ identifier: 'SpecStats', description: 'Cumulative speculative decoding acceptance statistics.' });
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
}).annotate({
  identifier: 'RequestRecord',
  description: 'Token counts and speeds recorded for one completed request.',
});
export type RequestRecord = typeof RequestRecord.Type;

export { slotContextTokens } from 'llamacpp-js/metrics';

/** A detailed reading: missing or null = unknown (not provided by this vendor or card). */
const Detail = Schema.Finite.pipe(Schema.NullOr, Schema.optionalKey);

/**
 * What the driver answers about direct transfers from a card to another (NVML's `nvmlGpuP2PStatus_t`, as `nvidia-smi
 * topo -p2p rw` shows it): `ok`, or what stands in the way, the chipset, the card, the PCI topology between them, a
 * driver setting, or no reason given (`unsupported`, `unknown`).
 */
export const GpuP2pStatus = Schema.Literals([
  'ok',
  'chipset',
  'gpu',
  'topology',
  'disabled',
  'unsupported',
  'unknown',
]).annotate({
  identifier: 'GpuP2pStatus',
  description: 'NVML peer-to-peer read/write status between two NVIDIA GPUs.',
});
export type GpuP2pStatus = typeof GpuP2pStatus.Type;

/**
 * Peer-to-peer from a card to the card at `busId`: what the driver allows, read and write, whether or not a program
 * uses it.
 */
export const GpuPeer = Schema.Struct({ busId: Schema.String, status: GpuP2pStatus }).annotate({
  identifier: 'GpuPeer',
  description: 'Peer-to-peer capability to another GPU identified by PCI busId.',
});
export type GpuPeer = typeof GpuPeer.Type;

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
  persistence: Schema.Boolean.pipe(Schema.NullOr, Schema.optionalKey),
  clockGrMhz: Detail,
  clockGrMaxMhz: Detail,
  clockMemMhz: Detail,
  pcieGen: Detail,
  pcieWidth: Detail,
  pcieGenMax: Detail,
  pcieWidthMax: Detail,
  pcieRxBps: Detail,
  pcieTxBps: Detail,
  /**
   * Peer-to-peer from this card to each other NVIDIA card that is read (NVML only); absent with a single card or
   * another collector.
   */
  p2p: GpuPeer.pipe(Schema.Array, Schema.optionalKey),
  /** Sleeping card (runtime-suspended), deliberately not read: any read would wake it up. */
  suspended: Schema.optionalKey(Schema.Boolean),
  /** Hidden card (hiddenGpus setting): listed but not read. */
  hidden: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: 'GpuSample', description: 'Live telemetry sample for one NVIDIA or AMD GPU.' });
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
}).annotate({ identifier: 'MemInfo', description: 'Host RAM and swap usage in bytes.' });
export type MemInfo = typeof MemInfo.Type;

/** The machine's DRAM bandwidth (memory controller, via perf): everything that touches RAM, CPU, GPU and NVMe included. */
export const MemBandwidth = Schema.Struct({ readBps: Schema.Finite, writeBps: Schema.Finite }).annotate({
  identifier: 'MemBandwidth',
  description: 'Host DRAM read and write bandwidth in bytes/s measured via perf.',
});
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
  memBw: MemBandwidth.pipe(Schema.NullOr, Schema.optionalKey),
}).annotate({ identifier: 'SystemSample', description: 'Host CPU, load average, RAM and DRAM bandwidth telemetry.' });
export type SystemSample = typeof SystemSample.Type;

export const DiskRates = Schema.Struct({ readBps: Schema.Finite, writeBps: Schema.Finite }).annotate({
  identifier: 'DiskRates',
  description: 'Disk read and write throughput in bytes/s.',
});
export type DiskRates = typeof DiskRates.Type;

/** The machine's physical disks: their total, each one (by block name, `nvme0n1`) and the model's. */
export const DiskSample = Schema.Struct({
  ...DiskRates.fields,
  perDisk: Schema.Record(Schema.String, DiskRates),
  model: Schema.NullOr(Schema.Struct({ disk: Schema.String, readBps: Schema.Finite })),
}).annotate({ identifier: 'DiskSample', description: 'Total, per-device and model-disk throughput in bytes/s.' });
export type DiskSample = typeof DiskSample.Type;

export const CpuInfo = Schema.Struct({
  model: Schema.String,
  physicalCores: Schema.Int,
  logicalThreads: Schema.Int,
  flags: Schema.Array(Schema.String),
  numaNodes: Schema.Int,
}).annotate({ identifier: 'CpuInfo', description: 'Static CPU model, topology and instruction flags.' });
export type CpuInfo = typeof CpuInfo.Type;

/** Keys of the history series: only what a chart draws (the other values are read live from the snapshot). */
export const SERIES = {
  genTps: 'llama.genTps',
  ppTps: 'llama.ppTps',
  gpuUtil: (gpuKey: string) => `gpu.${gpuKey}.util`,
  gpuVramPct: (gpuKey: string) => `gpu.${gpuKey}.vramPct`,
  sysCpu: 'sys.cpu',
  sysMemPct: 'sys.memPct',
  memRead: 'mem.read',
  memWrite: 'mem.write',
  diskRead: 'disk.read',
  diskWrite: 'disk.write',
  modelDiskRead: 'disk.modelRead',
} as const;

/** Monitoring state pushed on every tick over the WebSocket. */
export const Snapshot = Schema.Struct({
  at: Schema.Int,
  tick: Schema.Int,
  /** null: no active server. */
  health: Schema.NullOr(Health),
  rates: Schema.Struct({ genTps: Schema.Finite, ppTps: Schema.Finite }),
  slots: SlotView.pipe(Schema.Array, Schema.NullOr),
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
      dramBps: Schema.Finite.pipe(Schema.NullOr, Schema.optionalKey),
    }),
  ),
  system: Schema.NullOr(SystemSample),
  disk: Schema.NullOr(DiskSample),
  /** Values appended to the history on this tick, by `SERIES` key (null = gap). */
  points: Schema.Record(Schema.String, Schema.NullOr(Schema.Finite)),
  /** Shape of the history: a change (settings) invalidates the client's copy. */
  history: Schema.Struct({ intervalMs: Schema.Int, capacity: Schema.Int }),
}).annotate({
  identifier: 'Snapshot',
  description: 'One monitoring tick combining llama-server metrics, GPUs, host system and disk throughput.',
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
  series: Schema.Record(Schema.String, Schema.Finite.pipe(Schema.NullOr, Schema.Array)),
}).annotate({
  identifier: 'HistoryDump',
  description: 'Ring-buffer time series collected across monitoring ticks, oldest first (null indicates a gap).',
});
export type HistoryDump = typeof HistoryDump.Type;

/** Where the NVIDIA GPUs are read from: the NVML library, else the `nvidia-smi` program. */
export const NvidiaSource = Schema.Literals(['nvml', 'nvidia-smi']).annotate({
  identifier: 'NvidiaSource',
  description: 'Backend used to sample NVIDIA GPUs (libnvidia-ml or nvidia-smi fallback).',
});
export type NvidiaSource = typeof NvidiaSource.Type;

/** The machine as the System page shows it: its CPU, every GPU (hidden and sleeping ones included), the NVIDIA source. */
export const SystemInfo = Schema.Struct({
  cpu: CpuInfo,
  gpus: Schema.Array(GpuSample.mapFields(Struct.pick(['key', 'name', 'vendor', 'busId', 'vramTotalBytes']))),
  nvidiaSource: NvidiaSource,
}).annotate({
  identifier: 'SystemInfo',
  description:
    'Static host hardware summary (CPU, all GPUs including hidden/sleeping ones, and NVIDIA telemetry source).',
});
export type SystemInfo = typeof SystemInfo.Type;
