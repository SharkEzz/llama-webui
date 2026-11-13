/**
 * What the GPU readers must read (taken from llama-tui, without display settings):
 * everything is measured, except hidden cards (hiddenGpus setting), which are only identified.
 */
export interface GpuNeeds {
  /** false: no card is read. */
  gpus: boolean;
  /** PCIe bandwidth (NVML blocks ~50 ms per GPU to read it). */
  pcie: boolean;
  /** Hidden cards (PCI bus): not read. */
  skipGpus: string[];
}

export const MEASURE_ALL: GpuNeeds = { gpus: true, pcie: true, skipGpus: [] };

/** Card not to read: only identified. */
export const gpuSkipped = (n: GpuNeeds, busId: string) => !n.gpus || n.skipGpus.includes(busId);

export const gpuNeeds = (hiddenGpus: string[]): GpuNeeds => ({ gpus: true, pcie: true, skipGpus: hiddenGpus });
