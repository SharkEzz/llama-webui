// Page Topologie : graphe matériel (sysfs), placement du modèle (logs de llama-server) et phase d'inférence.
// Module sans DOM : partagé par le serveur et l'UI.

import type { Snapshot } from './monitor';
import type { ServerState } from './server';

export type TopologyNodeKind = 'cpu' | 'ram' | 'nvme' | 'gpu' | 'chipset';

export interface TopologyNode {
  /** `cpu`, `ram`, `pci:<busId>` (GPU, NVMe), `chipset:<busId du switch>`. */
  id: string;
  kind: TopologyNodeKind;
  label: string;
  /** Adresse PCI sysfs (`0000:01:00.0`), même format que `GpuSample.busId` et le réglage `hiddenGpus`. */
  busId?: string;
  vendor?: 'nvidia' | 'amd' | 'intel' | 'other';
  /** Périphérique bloc d'un NVMe (`nvme0n1`) : relie le nœud à `DiskSample.perDisk` et `model.disk`. */
  block?: string;
  /** Faits statiques affichés dans l'infobulle (modèle, cœurs, taille…) ; null = inconnu. */
  detail: Record<string, string | number | null>;
}

export interface TopologyLink {
  id: string;
  /** Côté CPU (amont). */
  from: string;
  to: string;
  kind: 'pcie' | 'memory' | 'internal';
  /** Capacité du lien (min des deux bouts) et état courant ; null = inconnu. */
  genMax: number | null;
  widthMax: number | null;
  genCur: number | null;
  widthCur: number | null;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  links: TopologyLink[];
  at: number;
}

/** Octets de modèle, de cache KV et de calcul d'un device, d'après les logs de chargement. */
export interface PlacementBuffer {
  /** Nom ggml : `CUDA0`, `ROCm0`, `Vulkan1`, `CPU`, `CPU_Mapped`, `CUDA_Host`… */
  device: string;
  /** Adresse PCI du device (ligne « using device »), null pour l'hôte ou si non loggée. */
  busId: string | null;
  modelBytes: number;
  /** Cache KV, plus l'état récurrent (« RS ») des modèles hybrides. */
  kvBytes: number;
  computeBytes: number;
}

export interface ModelPlacement {
  /** Numéro de la ligne « [llama-webui] lancement: » dont il est issu. */
  launchSeq: number;
  /** « offloaded N/M layers to GPU » ; null tant que la ligne n'est pas passée. */
  layers: { offloaded: number; total: number } | null;
  buffers: PlacementBuffer[];
}

/** Buffers côté hôte (RAM) : `CPU`, `CPU_Mapped` (mmap depuis le disque), `CPU_REPACK`, `CUDA_Host` (pinned)… */
export function hostDevice(device: string): boolean {
  return /^CPU(?:_|$)|_Host$/.test(device);
}

export function placementTotals(p: ModelPlacement): {
  modelBytes: number;
  gpuModelBytes: number;
  hostModelBytes: number;
} {
  let gpu = 0;
  let host = 0;
  for (const b of p.buffers) {
    if (hostDevice(b.device)) host += b.modelBytes;
    else gpu += b.modelBytes;
  }
  return { modelBytes: gpu + host, gpuModelBytes: gpu, hostModelBytes: host };
}

export type Phase = 'stopped' | 'loading' | 'idle' | 'prompt' | 'generating';

export const PHASE_LABEL: Record<Phase, string> = {
  stopped: 'Arrêté',
  loading: 'Chargement',
  idle: 'Inactif',
  prompt: 'Prompt',
  generating: 'Génération',
};

/** Ce que fait llama-server en ce moment, d'après l'état du superviseur et les slots du dernier tick. */
export function phaseOf(state: ServerState | undefined, snapshot: Snapshot | null): Phase {
  if (!state || state.kind === 'idle' || state.kind === 'stopping' || state.kind === 'crashed') return 'stopped';
  if (state.kind === 'starting' || snapshot?.health === 'loading') return 'loading';
  const busy = (snapshot?.slots ?? []).filter((s) => s.processing);
  if (busy.length === 0) return 'idle';
  // Pas encore de token généré : le prompt est en cours. `n_prompt_tokens` ne s'y prête pas : c'est le contexte du
  // slot, qui grossit des tokens générés, et `n_prompt_tokens_processed` exclut ce qui vient du cache.
  return busy.some((s) => s.nDecoded === 0) ? 'prompt' : 'generating';
}

/** Débit utile par voie et par sens (octets/s), après encodage : Gen1 8b/10b, Gen3+ 128b/130b. */
const LANE_BPS: Record<number, number> = {
  1: 0.25e9,
  2: 0.5e9,
  3: 0.985e9,
  4: 1.969e9,
  5: 3.938e9,
  6: 7.563e9,
};

/** Capacité d'un lien PCIe par sens (octets/s) ; null si la génération ou la largeur est inconnue. */
export function pcieBps(gen: number | null, width: number | null): number | null {
  if (gen === null || width === null || width <= 0) return null;
  const lane = LANE_BPS[gen];
  return lane === undefined ? null : lane * width;
}
