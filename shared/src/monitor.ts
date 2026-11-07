// Types de monitoring sérialisables (copiés de llama-tui, sans Map), partagés par le serveur et l'UI.

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
  // Champs détaillés : absent ou null = inconnu (non fourni par ce vendeur ou cette carte).
  memUtilPct?: number | null;
  fanPct?: number | null;
  powerLimitW?: number | null;
  /** Limite de puissance d'usine (NVIDIA) ; diffère de `powerLimitW` si l'utilisateur l'a baissée. */
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
  /** Carte en veille (runtime-suspended) volontairement non lue : toute lecture la réveillerait. */
  suspended?: boolean;
  /** Carte masquée (réglage hiddenGpus) : listée mais non lue. */
  hidden?: boolean;
}

export interface MemInfo {
  totalBytes: number;
  availableBytes: number;
  cachedBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

/** Bande passante DRAM de la machine (contrôleur mémoire, via perf) : tout ce qui touche la RAM, CPU, GPU et NVMe compris. */
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
  /** Absent ou null : non mesurable (perf absent, PMU inconnu, droits). */
  memBw?: MemBandwidth | null;
}

export interface DiskSample {
  readBps: number;
  writeBps: number;
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

/** Clés des séries d'historique. */
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

/** État de monitoring poussé à chaque tick sur le WebSocket. */
export interface Snapshot {
  at: number;
  tick: number;
  /** null : aucun serveur actif. */
  health: Health | null;
  rates: { genTps: number; ppTps: number };
  slots: SlotView[] | null;
  kv: { usedTokens: number; totalTokens: number } | null;
  queue: { processing: number; deferred: number; busySlots: number } | null;
  lastRequest: RequestStats | null;
  spec: SpecStats | null;
  /** Plus récente d'abord. */
  recentRequests: RequestRecord[];
  /** GPU utilisées par le serveur (VRAM > 64 Mio). */
  gpus: GpuSample[];
  /** Toutes les GPU, triées par busId, masquées et en veille comprises (non lues). */
  allGpus: GpuSample[];
  /** `dramBps` : octets/s ramenés de la DRAM par llama-server (perf, événement cœur) ; null = inconnu. */
  proc: { cpuPct: number; rssBytes: number; dramBps?: number | null } | null;
  system: SystemSample | null;
  disk: DiskSample | null;
  /** Valeurs ajoutées à l'historique à ce tick (NaN → null). */
  points: Record<string, number | null>;
  /** Forme de l'historique : un changement (réglages) invalide celui du client. */
  history: { intervalMs: number; capacity: number };
}

/** Historique complet : une valeur par tick, la plus ancienne d'abord, `null` = trou. */
export interface HistoryDump {
  intervalMs: number;
  capacity: number;
  /** Instant du dernier point. */
  at: number;
  /** Instant de chaque point (ms), même longueur que chaque série. */
  times: number[];
  series: Record<string, (number | null)[]>;
}
