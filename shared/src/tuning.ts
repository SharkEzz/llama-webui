import type { BenchDevice, BenchParams } from './bench';
import type { CpuInfo } from './monitor';

export type PresetId = 'chat' | 'agent' | 'context' | 'fit' | 'big';

export interface Preset {
  id: PresetId;
  label: string;
  /** Explication d'une ligne. */
  hint: string;
  /** Contexte visé ; Infinity = le plus grand qui tient. */
  ctxTarget: number;
  /** L'estimation ne descend jamais en dessous. */
  ctxMin: number;
  kvPreferred: 'f16' | 'q8_0';
  ub: number;
  /** Plus haut = meilleur. */
  score(r: { ppTps: number; tgTps: number; ctx: number }): number;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'chat',
    label: 'Chat réactif',
    hint: "débit de génération d'abord, 32 k de contexte",
    ctxTarget: 32768,
    ctxMin: 8192,
    kvPreferred: 'f16',
    ub: 512,
    score: (r) => r.tgTps,
  },
  {
    id: 'agent',
    label: 'Agent & RAG',
    hint: 'longs prompts : prompt processing et génération',
    ctxTarget: 65536,
    ctxMin: 16384,
    kvPreferred: 'q8_0',
    ub: 2048,
    score: (r) => 0.6 * r.ppTps + 0.4 * r.tgTps,
  },
  {
    id: 'context',
    label: 'Contexte max',
    hint: 'le plus grand contexte qui tient, puis la génération',
    ctxTarget: Number.POSITIVE_INFINITY,
    ctxMin: 8192,
    kvPreferred: 'q8_0',
    ub: 512,
    score: (r) => r.ctx * 1e6 + r.tgTps,
  },
  {
    id: 'fit',
    label: 'Faire tenir le modèle',
    hint: "qu'il démarre et réponde, même lentement",
    ctxTarget: 8192,
    ctxMin: 8192,
    kvPreferred: 'q8_0',
    ub: 512,
    score: (r) => r.tgTps,
  },
  {
    id: 'big',
    label: 'Modèle de 100 Go',
    hint: 'experts MoE en RAM, attention et normes sur toutes les cartes',
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
  if (!p) throw new Error(`préréglage inconnu : ${id}`);
  return p;
}

/** Bruit de mesure relatif de llama-bench (J5 : pp ±8–15 % d'un run à l'autre, tg < 1 %). En dessous, deux configs ne se départagent pas. */
export const NOISE = { pp: 0.1, tg: 0.02 } as const;

export type FitVerdict = 'fits' | 'tight' | 'no';

export interface DeviceBudget {
  device: string;
  /** Octets estimés sur le device. */
  bytes: number;
  /** Utilisable : total moins la marge (contexte CUDA, fragmentation). */
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
  /** serverArgs(params) puis -c, -t, -b, -ub, --fit off, --mlock et --numa s'il y a lieu. */
  serverArgs: string[];
  rows: Recommendation[];
  fit: Fit;
  /** Ce qui dépasse la RAM disponible (relu depuis le disque par mmap). */
  ramOverflowBytes: number;
  /** Octets lus sur le disque par jeton généré quand la RAM déborde (0 sinon). */
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
  /** Combinaisons retirées parce qu'elles ne tiennent pas. */
  excluded: number;
  /** Paires (-dev, -ts) écartées faute de longueurs égales. */
  droppedTs: number;
  estimatedSeconds: number;
}

export type CheckState = 'ok' | 'warn' | 'unknown' | 'na';
export type CheckFamily = 'nvidia' | 'amd' | 'cpu' | 'build' | 'kernel';

export interface Check {
  /** Stable : "nvidia.persistence.<busId>", "cpu.governor"… */
  id: string;
  family: CheckFamily;
  label: string;
  state: CheckState;
  detail: string;
  /** La commande exacte à lancer, s'il y en a une. */
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
 * Rôle d'un device de `--list-devices` : une carte dédiée (« gpu »), la copie Vulkan d'une carte déjà vue en CUDA
 * (« duplicate »), un iGPU qui partage la RAM (« integrated » : Vulkan qui porte le nom du processeur) ou l'hôte (BLAS, CPU).
 */
export function deviceRole(d: BenchDevice, all: BenchDevice[]): 'gpu' | 'duplicate' | 'integrated' | 'host' {
  if (d.backend === 'BLAS' || d.backend === 'CPU' || d.totalMib <= 0) return 'host';
  if (d.backend === 'CUDA') return 'gpu';
  if (/processor|\bAPU\b/i.test(d.name)) return 'integrated';
  if (all.some((o) => o.backend === 'CUDA' && d.name.startsWith(o.name))) return 'duplicate';
  return 'gpu';
}

/** Les cartes dédiées, dans l'ordre de `--list-devices` : ce qu'un `-dev` absent veut dire pour l'estimation. */
export const gpuDevices = (all: BenchDevice[]): BenchDevice[] => all.filter((d) => deviceRole(d, all) === 'gpu');
