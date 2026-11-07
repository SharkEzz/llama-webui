// Serializable monitoring types (copied from llama-tui, without Map), shared by the server and the UI.

export interface GpuSample {
  key: string; // "nvidia:<uuid>" | "amd:<pdev>"
  vendor: 'nvidia' | 'amd';
  name: string;
  busId: string; // "0000:01:00.0"
  utilPct: number | null;
  vramUsedBytes: number;
  vramTotalBytes: number;
  tempC: number | null;
  powerW: number | null;
  procVramBytes: number;
  // Detailed fields: missing or null = unknown (not provided by this vendor or card).
  memUtilPct?: number | null;
  fanPct?: number | null;
  powerLimitW?: number | null;
  /** Factory power limit (NVIDIA); differs from `powerLimitW` if the user lowered it. */
  powerDefaultLimitW?: number | null;
  persistence?: boolean | null;
  clockGrMhz?: number | null;
  clockGrMaxMhz?: number | null;
  clockMemMhz?: number | null;
  pcieGen?: number | null;
  pcieWidth?: number | null;
  pcieGenMax?: number | null;
  pcieWidthMax?: number | null;
  pcieRxBps?: number | null;
  pcieTxBps?: number | null;
  /** Sleeping card (runtime-suspended), deliberately not read: any read would wake it up. */
  suspended?: boolean;
  /** Hidden card (hiddenGpus setting): listed but not read. */
  hidden?: boolean;
}

export interface MemInfo {
  totalBytes: number;
  availableBytes: number;
  cachedBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

/** The machine's DRAM bandwidth (memory controller, via perf): everything that touches RAM, CPU, GPU and NVMe included. */
export interface MemBandwidth {
  readBps: number;
  writeBps: number;
}

export interface SystemSample {
  cpuPct: number;
  corePct: number[];
  freqMhz: number | null;
  tempC: number | null;
  load: [number, number, number] | null;
  mem: MemInfo | null;
  /** Missing or null: not measurable (no perf, unknown PMU, permissions). */
  memBw?: MemBandwidth | null;
}

export interface DiskRates {
  readBps: number;
  writeBps: number;
}

/** The machine's physical disks: their total, each one (by block name, `nvme0n1`) and the model's. */
export interface DiskSample extends DiskRates {
  perDisk: Record<string, DiskRates>;
  model: { disk: string; readBps: number } | null;
}

export interface SlotView {
  id: number;
  nCtx: number;
  processing: boolean;
  idTask: number | null;
  nPromptTokens: number;
  nPromptProcessed: number;
  nDecoded: number;
  nRemain: number | null;
}

/**
 * Tokens used in a slot's context. `n_prompt_tokens` is already the whole context: the prompt plus the tokens generated
 * so far (kept in cache once the request is done). Adding `n_decoded` would count the output twice.
 */
export const slotContextTokens = (s: SlotView): number => s.nPromptTokens;

export type Health = 'ok' | 'loading' | 'error' | 'down';

export interface RequestStats {
  genTps: number | null;
  ppTps: number | null;
  specAccept: number | null;
}

export interface SpecStats {
  acceptCum: number | null;
  drafts: number;
  draftTokens: number;
  accepted: number;
  meanAcceptedPerDraft: number | null;
  perPos: number[];
}

export interface RequestRecord {
  at: number;
  promptTokens: number;
  cachedTokens: number;
  genTokens: number;
  promptSec: number | null;
  genSec: number | null;
  ppTps: number | null;
  genTps: number | null;
  specAccept: number | null;
}

export interface CpuInfo {
  model: string;
  physicalCores: number;
  logicalThreads: number;
  flags: string[];
  numaNodes: number;
}

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
export interface Snapshot {
  at: number;
  tick: number;
  /** null: no active server. */
  health: Health | null;
  rates: { genTps: number; ppTps: number };
  slots: SlotView[] | null;
  kv: { usedTokens: number; totalTokens: number } | null;
  queue: { processing: number; deferred: number; busySlots: number } | null;
  lastRequest: RequestStats | null;
  spec: SpecStats | null;
  /** Most recent first. */
  recentRequests: RequestRecord[];
  /** GPUs used by the server (VRAM > 64 MiB). */
  gpus: GpuSample[];
  /** All GPUs, sorted by busId, hidden and sleeping ones included (not read). */
  allGpus: GpuSample[];
  /** `dramBps`: bytes/s fetched from DRAM by llama-server (perf, core event); null = unknown. */
  proc: { cpuPct: number; rssBytes: number; dramBps?: number | null } | null;
  system: SystemSample | null;
  disk: DiskSample | null;
  /** Values appended to the history on this tick (NaN → null). */
  points: Record<string, number | null>;
  /** Shape of the history: a change (settings) invalidates the client's copy. */
  history: { intervalMs: number; capacity: number };
}

/** Full history: one value per tick, oldest first, `null` = gap. */
export interface HistoryDump {
  intervalMs: number;
  capacity: number;
  /** Time of the last point. */
  at: number;
  /** Time of each point (ms), same length as each series. */
  times: number[];
  series: Record<string, (number | null)[]>;
}
