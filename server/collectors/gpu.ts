import type { GpuSample } from "@llama-webui/shared";

export type { GpuSample };
export type GpuReading = Omit<GpuSample, "procVramBytes">;

/** A card listed without its readings: asleep (`suspended`), or shown nowhere (`hidden`). */
export function identityReading(
  g: Pick<GpuReading, "key" | "vendor" | "name" | "busId">,
  why: "suspended" | "hidden",
): GpuReading {
  return {
    key: g.key,
    vendor: g.vendor,
    name: g.name,
    busId: g.busId,
    utilPct: null,
    vramUsedBytes: 0,
    vramTotalBytes: 0,
    tempC: null,
    powerW: null,
    ...(why === "suspended" ? { suspended: true } : { hidden: true }),
  };
}

export const USED_GPU_THRESHOLD_BYTES = 64 * 1024 ** 2;

export function normalizeBusId(id: string): string {
  const s = id.trim().toLowerCase();
  const m = /^([0-9a-f]+):([0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])$/.exec(s);
  if (!m) return s;
  return `${m[1]!.slice(-4).padStart(4, "0")}:${m[2]}`;
}

export function selectUsedGpus(gpus: GpuSample[]): GpuSample[] {
  return gpus.filter((g) => g.procVramBytes > USED_GPU_THRESHOLD_BYTES).sort((a, b) => a.busId.localeCompare(b.busId));
}
