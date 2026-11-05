/**
 * Ce que les lecteurs de GPU doivent lire (repris de llama-tui, sans réglages d'affichage) :
 * tout est mesuré, sauf les cartes masquées (réglage hiddenGpus), seulement identifiées.
 */
export interface GpuNeeds {
  /** false : aucune carte n'est lue. */
  gpus: boolean;
  /** Débit PCIe (NVML bloque ~50 ms par GPU pour le lire). */
  pcie: boolean;
  /** Cartes masquées (bus PCI) : non lues. */
  skipGpus: string[];
}

export const MEASURE_ALL: GpuNeeds = { gpus: true, pcie: true, skipGpus: [] };

/** Carte à ne pas lire : seulement identifiée. */
export const gpuSkipped = (n: GpuNeeds, busId: string) => !n.gpus || n.skipGpus.includes(busId);

export const gpuNeeds = (hiddenGpus: string[]): GpuNeeds => ({ gpus: true, pcie: true, skipGpus: hiddenGpus });
