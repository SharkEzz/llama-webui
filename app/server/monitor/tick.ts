import {
  type DiskSample,
  type GpuSample,
  type MemBandwidth,
  SERIES,
  type Snapshot,
  type SystemSample,
} from '@llama-webui/shared';
import { Array as Arr, Option, Record } from 'effect';
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
import type { History } from './History.ts';

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
  /** A server is `starting`, `ready`, `stopping` or `external`. */
  readonly active: boolean;
  readonly pid: number | null;
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

/** The points of one tick, pushed into `history` as they are recorded. */
const recorder = (history: History) => {
  const points: Record<string, number | null> = {};
  /** The tick's value of a series (NaN: a gap). */
  const push = (key: string, v: number) => {
    history.series(key).push(v);
    points[key] = Number.isFinite(v) ? v : null;
  };
  /** A series starts at its first known value; an existing one gets a gap when the value is unknown. */
  const known = (key: string, v: number | null | undefined) => {
    if (v !== null && v !== undefined && Number.isFinite(v)) push(key, v);
    else if (history.has(key)) push(key, Number.NaN);
  };
  /** Every existing series not fed on this tick gets a gap: they all move together, aligned on the times. */
  const finish = () => {
    for (const key of history.keys()) if (!Record.has(points, key)) push(key, Number.NaN);
    return points;
  };
  return { push, known, finish };
};

type Recorder = ReturnType<typeof recorder>;

/** The series of every card in the machine, whether the server uses it or not. */
const pushGpus = (r: Recorder, gpus: ReadonlyArray<GpuSample>) => {
  for (const g of gpus) {
    r.push(SERIES.gpuUtil(g.key), g.suspended === true || g.hidden === true ? Number.NaN : (g.utilPct ?? 0));
    r.known(SERIES.gpuVramPct(g.key), g.vramTotalBytes > 0 ? (100 * g.vramUsedBytes) / g.vramTotalBytes : null);
    r.known(SERIES.gpuPcieRx(g.key), g.pcieRxBps);
    r.known(SERIES.gpuPcieTx(g.key), g.pcieTxBps);
    r.known(SERIES.gpuPower(g.key), g.powerW);
    r.known(SERIES.gpuTemp(g.key), g.tempC);
  }
};

/** CPU, memory and the disks with their series: a collector off feeds none of them (its series get gaps). */
const pushMachine = (r: Recorder, reading: TickReading) => {
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
    r.known(SERIES.sysTemp, s?.tempC);
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

const lastAcceptance = (history: History): number =>
  Option.getOrElse(history.series(SERIES.specAccept).last(), () => 0);

/** Pushes one point per series into `history` and builds the snapshot. */
export const endTick: {
  (history: History, reading: TickReading): (memory: TickMemory) => { memory: TickMemory; snapshot: Snapshot };
  (memory: TickMemory, history: History, reading: TickReading): { memory: TickMemory; snapshot: Snapshot };
} = dual(3, (memory: TickMemory, history: History, reading: TickReading) => {
  history.tick(reading.at);
  const r = recorder(history);
  pushGpus(r, reading.allGpus);
  const machine = pushMachine(r, reading);

  if (!reading.active) {
    r.push(SERIES.genTps, 0);
    r.push(SERIES.ppTps, 0);
    r.push(SERIES.specAccept, lastAcceptance(history));
    r.push(SERIES.cpuPct, 0);
    r.push(SERIES.kvPct, 0);
    r.push(SERIES.reqProcessing, 0);
    r.push(SERIES.reqDeferred, 0);
    r.push(SERIES.busySlots, 0);
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

  const raw = reading.raw;
  r.known(SERIES.procDram, reading.dramBps);
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
  r.push(SERIES.specAccept, next.lastRequest?.specAccept ?? lastAcceptance(history));
  r.push(SERIES.cpuPct, reading.proc?.cpuPct ?? 0);
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
  r.push(SERIES.kvPct, kv === null ? 0 : (100 * kv.usedTokens) / kv.totalTokens);
  r.push(SERIES.reqProcessing, queue?.processing ?? 0);
  r.push(SERIES.reqDeferred, queue?.deferred ?? 0);
  r.push(SERIES.busySlots, queue?.busySlots ?? 0);

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
