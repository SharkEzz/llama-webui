import {
  type DiskSample,
  type GpuSample,
  type MemBandwidth,
  SERIES,
  type Snapshot,
  type SystemSample,
} from '@llama-webui/shared';
import { Array as Arr, Option } from 'effect';
import { dual } from 'effect/Function';
import {
  foldRecent,
  kvUsage,
  type LlamaRaw,
  lastRequestStats,
  liveRates,
  mergeRequestStats,
  type RequestRecord,
  type RequestStats,
  requestDelta,
  type SpecStats,
  specStats,
} from 'llamacpp-js/metrics';
import { selectUsedGpus } from '../collectors/gpu.ts';
import {
  finite,
  finiteDisk,
  finiteGpu,
  finiteOrNull,
  finiteRecord,
  finiteRequestStats,
  finiteSlot,
  finiteSpec,
  finiteSystem,
  int,
} from './finite.ts';
import type { History, HistoryRecorder } from './History.ts';

/** What one tick leaves to the next: the counts and what the rates and the request stats are computed from. */
export interface TickMemory {
  readonly tickNo: number;
  /** The pid of the previous tick: a new one starts the counters over. */
  readonly lastPid: number | null;
  /** Ticks of an active server with this pid, this one included. */
  readonly ticksForPid: number;
  readonly prevRaw: LlamaRaw | null;
  readonly prevMetrics: ReadonlyMap<string, number> | null;
  readonly lastRequest: RequestStats | null;
  /** Most recent first. */
  readonly recentRequests: ReadonlyArray<RequestRecord>;
  readonly spec: SpecStats | null;
}

export const initialMemory: TickMemory = {
  tickNo: 0,
  lastPid: null,
  ticksForPid: 0,
  prevRaw: null,
  prevMetrics: null,
  lastRequest: null,
  recentRequests: [],
  spec: null,
};

/** What a tick does about `/slots`: reads it, keeps the slots it knows (nothing moved), or has none to give. */
export type SlotsPlan = 'read' | 'keep' | 'skip';

/** The counters of `/metrics` that move whenever llama-server worked on a request. */
const WORK_COUNTERS = ['prompt_tokens_total', 'tokens_predicted_total', 'n_decode_total'] as const;

const metricOf = (metrics: ReadonlyMap<string, number>, key: string) => metrics.get(`llamacpp:${key}`) ?? 0;

/**
 * What a tick does about `/slots`, from the `/metrics` it just read. For llama-server a `GET /slots` is activity: read
 * on every tick, it would put off the sleep of `--sleep-idle-seconds` for ever, and it wakes a sleeping server or
 * waits for its model. `/metrics` does neither, so the slots are read only when they may have moved: none known yet, a
 * request running or waiting, a slot the last read left busy, or work counted since the last tick; else the known
 * ones are kept. A server without `--metrics` gives no such sign and is read on every tick. `skip`: no read and no
 * slots, when they are barred (`noSlots`: asleep, waking up or stopping) or when `/metrics` did not answer (`/slots`
 * waits on the same queue).
 */
export const slotsPlan: {
  (read: {
    readonly noSlots: boolean;
    readonly metrics: ReadonlyMap<string, number> | null;
  }): (memory: TickMemory) => SlotsPlan;
  (
    memory: TickMemory,
    read: { readonly noSlots: boolean; readonly metrics: ReadonlyMap<string, number> | null },
  ): SlotsPlan;
} = dual(
  2,
  (
    memory: TickMemory,
    { noSlots, metrics }: { readonly noSlots: boolean; readonly metrics: ReadonlyMap<string, number> | null },
  ): SlotsPlan => {
    if (noSlots || metrics === null) return 'skip';
    if (!metrics.has('llamacpp:requests_processing')) return 'read';
    const known = memory.prevRaw?.slots ?? null;
    const before = memory.prevMetrics;
    if (known === null || before === null) return 'read';
    if (metricOf(metrics, 'requests_processing') > 0 || metricOf(metrics, 'requests_deferred') > 0) return 'read';
    if (Arr.some(known, (slot) => slot.processing)) return 'read';
    if (Arr.some(WORK_COUNTERS, (key) => metricOf(metrics, key) !== metricOf(before, key))) return 'read';
    return 'keep';
  },
);

/** Before the reads: a new pid resets every counter (no rate across two processes); counts the tick. */
export const beginTick: {
  (pid: number | null, active: boolean): (memory: TickMemory) => TickMemory;
  (memory: TickMemory, pid: number | null, active: boolean): TickMemory;
} = dual(3, (memory: TickMemory, pid: number | null, active: boolean): TickMemory => {
  const kept: TickMemory = pid === memory.lastPid ? memory : { ...initialMemory, tickNo: memory.tickNo, lastPid: pid };
  return { ...kept, tickNo: kept.tickNo + 1, ticksForPid: active ? kept.ticksForPid + 1 : kept.ticksForPid };
});

/** What a tick read. */
export interface TickReading {
  readonly at: number;
  /** A server is `starting`, `ready`, `sleeping`, `stopping` or `external`. */
  readonly active: boolean;
  readonly pid: number | null;
  /** `/slots` is barred: the server is asleep, waking up or stopping. */
  readonly noSlots: boolean;
  /** llama-server's read; null while no server is active. */
  readonly raw: LlamaRaw | null;
  /** Every card, sorted by bus id, hidden and sleeping ones included. */
  readonly allGpus: ReadonlyArray<GpuSample>;
  readonly proc: { readonly cpuPct: number; readonly rssBytes: number } | null;
  /** Bytes/s llama-server fetched from DRAM (perf); null if unknown. */
  readonly dramBps: number | null;
  /** None: the collector is off; null: its read failed. */
  readonly system: Option.Option<SystemSample | null>;
  /** None: the collector is off; null: its read failed. */
  readonly disk: Option.Option<DiskSample | null>;
  /** The machine's DRAM bandwidth (perf); null if unknown. */
  readonly memBw: MemBandwidth | null;
}

/** The series of every card in the machine, whether the server uses it or not. */
const pushGpus = (r: HistoryRecorder, gpus: ReadonlyArray<GpuSample>) => {
  for (const g of gpus) {
    r.push(SERIES.gpuUtil(g.key), g.suspended === true || g.hidden === true ? Number.NaN : (g.utilPct ?? 0));
    r.known(SERIES.gpuVramPct(g.key), g.vramTotalBytes > 0 ? (100 * g.vramUsedBytes) / g.vramTotalBytes : null);
  }
};

/** CPU, memory and the disks with their series: a collector off feeds none of them (its series get gaps). */
const pushMachine = (r: HistoryRecorder, reading: TickReading) => {
  const system = Option.map(reading.system, (s) => (s === null ? null : { ...s, memBw: reading.memBw }));
  if (Option.isSome(system)) {
    const s = system.value;
    r.known(SERIES.memRead, reading.memBw?.readBps);
    r.known(SERIES.memWrite, reading.memBw?.writeBps);
    r.push(SERIES.sysCpu, s?.cpuPct ?? 0);
    const mem = s?.mem ?? null;
    r.push(
      SERIES.sysMemPct,
      mem !== null && mem.totalBytes > 0 ? (100 * (mem.totalBytes - mem.availableBytes)) / mem.totalBytes : 0,
    );
  }
  if (Option.isSome(reading.disk)) {
    const d = reading.disk.value;
    r.push(SERIES.diskRead, d?.readBps ?? 0);
    r.push(SERIES.diskWrite, d?.writeBps ?? 0);
    r.push(SERIES.modelDiskRead, d?.model?.readBps ?? 0);
  }
  return {
    system: Option.getOrNull(system),
    disk: Option.getOrNull(reading.disk),
  };
};

/** `raw` with the slots the last read left, when this tick kept them instead of reading `/slots` (`slotsPlan`). */
const withKnownSlots = (memory: TickMemory, noSlots: boolean, raw: LlamaRaw): LlamaRaw =>
  raw.health === 'ok' && raw.slots === null && slotsPlan(memory, { noSlots, metrics: raw.metrics }) === 'keep'
    ? { ...raw, slots: memory.prevRaw?.slots ?? null }
    : raw;

/** Pushes one point per series into `history` and builds the snapshot. */
export const endTick: {
  (history: History, reading: TickReading): (memory: TickMemory) => { memory: TickMemory; snapshot: Snapshot };
  (memory: TickMemory, history: History, reading: TickReading): { memory: TickMemory; snapshot: Snapshot };
} = dual(3, (memory: TickMemory, history: History, reading: TickReading) => {
  history.tick(reading.at);
  const r = history.recorder();
  pushGpus(r, reading.allGpus);
  const machine = pushMachine(r, reading);

  if (!reading.active) {
    r.push(SERIES.genTps, 0);
    r.push(SERIES.ppTps, 0);
    return {
      memory,
      snapshot: snapshotOf(history, r.finish(), memory, reading, {
        ...machine,
        health: null,
        rates: { genTps: 0, ppTps: 0 },
        slots: null,
        kv: null,
        queue: null,
        gpus: [],
        proc: null,
      }),
    };
  }

  const raw = reading.raw === null ? null : withKnownSlots(memory, reading.noSlots, reading.raw);
  const rates = raw === null ? { genTps: 0, ppTps: 0 } : liveRates(memory.prevRaw, raw);
  let next: TickMemory = raw === null ? memory : { ...memory, prevRaw: raw };
  const metrics = raw?.metrics ?? null;
  if (metrics !== null) {
    const prev = memory.prevMetrics === null ? null : new Map(memory.prevMetrics);
    next = {
      ...next,
      ...(prev === null
        ? {}
        : {
            lastRequest: mergeRequestStats(memory.lastRequest, lastRequestStats(prev, metrics)),
            recentRequests: foldRecent([...memory.recentRequests], requestDelta(prev, metrics, reading.at)),
          }),
      spec: specStats(metrics),
      prevMetrics: metrics,
    };
  }

  r.push(SERIES.genTps, rates.genTps);
  r.push(SERIES.ppTps, rates.ppTps);
  const kv = kvUsage(raw?.slots ?? null);
  const metric = (key: string) => metrics?.get(`llamacpp:${key}`) ?? 0;
  const queue =
    metrics === null
      ? null
      : {
          processing: metric('requests_processing'),
          deferred: metric('requests_deferred'),
          busySlots: metric('n_busy_slots_per_decode'),
        };

  return {
    memory: next,
    snapshot: snapshotOf(history, r.finish(), next, reading, {
      ...machine,
      health: raw?.health ?? 'down',
      rates: { genTps: finite(rates.genTps), ppTps: finite(rates.ppTps) },
      slots: raw?.slots === null || raw?.slots === undefined ? null : Arr.map(raw.slots, finiteSlot),
      kv: kv === null ? null : { usedTokens: int(kv.usedTokens), totalTokens: int(kv.totalTokens) },
      queue:
        queue === null
          ? null
          : { processing: int(queue.processing), deferred: int(queue.deferred), busySlots: finite(queue.busySlots) },
      gpus: reading.pid === null ? [] : selectUsedGpus(reading.allGpus),
      proc:
        reading.proc === null
          ? null
          : {
              cpuPct: finite(reading.proc.cpuPct),
              rssBytes: finite(reading.proc.rssBytes),
              dramBps: finiteOrNull(reading.dramBps),
            },
    }),
  };
});

/** The snapshot of a tick, every number in it finite. */
const snapshotOf = (
  history: History,
  points: Snapshot['points'],
  memory: TickMemory,
  reading: TickReading,
  part: Pick<Snapshot, 'health' | 'rates' | 'slots' | 'kv' | 'queue' | 'gpus' | 'proc' | 'system' | 'disk'>,
): Snapshot => ({
  at: int(reading.at),
  tick: memory.tickNo,
  health: part.health,
  rates: part.rates,
  slots: part.slots,
  kv: part.kv,
  queue: part.queue,
  lastRequest: memory.lastRequest === null ? null : finiteRequestStats(memory.lastRequest),
  spec: memory.spec === null ? null : finiteSpec(memory.spec),
  recentRequests: Arr.map(memory.recentRequests, finiteRecord),
  gpus: Arr.map(part.gpus, finiteGpu),
  allGpus: Arr.map(reading.allGpus, finiteGpu),
  proc: part.proc,
  system: part.system === null ? null : finiteSystem(part.system),
  disk: part.disk === null ? null : finiteDisk(part.disk),
  points,
  history: { intervalMs: history.intervalMs, capacity: history.capacity },
});
