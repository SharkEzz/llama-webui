import type { GpuReading, GpuSample } from '@llama-webui/shared';
import { Array as Arr, type Effect, Option, Order, String as Str } from 'effect';
import { dual, pipe } from 'effect/Function';

/**
 * What the GPU readers must read: everything is measured, except hidden cards (the `hiddenGpus` setting), which are
 * only identified.
 */
export interface GpuNeeds {
  /** PCIe bandwidth (NVML blocks about 50 ms per GPU to read it). */
  readonly pcie: boolean;
  /** Hidden cards (PCI bus ids): not read. */
  readonly skipGpus: ReadonlyArray<string>;
}

export const MEASURE_ALL: GpuNeeds = { pcie: true, skipGpus: [] };

export const gpuNeeds = (hiddenGpus: ReadonlyArray<string>): GpuNeeds => ({
  pcie: true,
  skipGpus: hiddenGpus,
});

/** A card not to read: only identified. */
export const gpuSkipped: {
  (busId: string): (needs: GpuNeeds) => boolean;
  (needs: GpuNeeds, busId: string): boolean;
} = dual(2, (needs: GpuNeeds, busId: string): boolean => needs.skipGpus.includes(busId));

/** A card listed without its readings: asleep (`suspended`), or shown nowhere (`hidden`). */
type Identity = Pick<GpuReading, 'key' | 'vendor' | 'name' | 'busId'>;

export const identityReading: {
  (why: 'suspended' | 'hidden'): (g: Identity) => GpuReading;
  (g: Identity, why: 'suspended' | 'hidden'): GpuReading;
} = dual(
  2,
  (g: Identity, why: 'suspended' | 'hidden'): GpuReading => ({
    key: g.key,
    vendor: g.vendor,
    name: g.name,
    busId: g.busId,
    utilPct: null,
    vramUsedBytes: 0,
    vramTotalBytes: 0,
    tempC: null,
    powerW: null,
    ...(why === 'suspended' ? { suspended: true } : { hidden: true }),
  }),
);

/** A PCI bus id in the form of sysfs: `00000000:01:00.0` and `0000:0D:00.0` give `0000:01:00.0`, `0000:0d:00.0`. */
export const normalizeBusId = (id: string): string => {
  const s = Str.toLowerCase(Str.trim(id));
  const m = /^([0-9a-f]+):([0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])$/.exec(s);
  return m === null ? s : `${pipe(m[1] ?? '', Str.slice(-4), Str.padStart(4, '0'))}:${m[2] ?? ''}`;
};

/** A card that holds less of llama-server's VRAM than this is not one of its cards. */
export const USED_GPU_THRESHOLD_BYTES = 64 * 1024 ** 2;

/** The cards llama-server uses, by bus id. */
export const selectUsedGpus = (gpus: ReadonlyArray<GpuSample>): ReadonlyArray<GpuSample> =>
  pipe(
    gpus,
    Arr.filter((g) => g.procVramBytes > USED_GPU_THRESHOLD_BYTES),
    Arr.sort(Order.mapInput(Order.String, (g: GpuSample) => g.busId)),
  );

/** A process on a card (`key`), as an NVIDIA reader reports it: its VRAM there, null when the driver cannot tell. */
export interface CardProcess {
  readonly pid: number;
  readonly key: string;
  readonly usedBytes: number | null;
}

/**
 * The VRAM `pid` holds on each card of `readings`. A process whose VRAM the driver cannot report (NVML's
 * `NVML_VALUE_NOT_AVAILABLE`, nvidia-smi's `[N/A]`) counts the card's VRAM in use (an upper bound), so the card still
 * shows as used by it.
 */
export const procVramOf: {
  (pid: number): (readings: CardReadings) => ReadonlyMap<string, number>;
  (readings: CardReadings, pid: number): ReadonlyMap<string, number>;
} = dual(2, (readings: CardReadings, pid: number): ReadonlyMap<string, number> => {
  const vram = new Map<string, number>();
  const unknown = new Set<string>();
  for (const p of readings.procs) {
    if (p.pid !== pid) continue;
    if (p.usedBytes === null) unknown.add(p.key);
    else vram.set(p.key, (vram.get(p.key) ?? 0) + p.usedBytes);
  }
  for (const key of unknown) {
    const card = Arr.findFirst(readings.gpus, (g) => g.key === key);
    vram.set(key, Option.isSome(card) ? card.value.vramUsedBytes : (vram.get(key) ?? 0));
  }
  return vram;
});

/** The cards and the processes on them, as one reading of an NVIDIA reader. */
export interface CardReadings {
  readonly gpus: ReadonlyArray<GpuReading>;
  readonly procs: ReadonlyArray<CardProcess>;
}

/** What every NVIDIA reader (NVML, `nvidia-smi`) gives the collector. */
export interface NvidiaReader {
  readonly gpus: Effect.Effect<ReadonlyArray<GpuReading>>;
  readonly procVram: (pid: number) => Effect.Effect<ReadonlyMap<string, number>>;
  readonly refreshApps: Effect.Effect<void>;
  readonly configure: (o: { readonly intervalMs: number; readonly needs: GpuNeeds }) => Effect.Effect<void>;
}
