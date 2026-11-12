import type {
  GpuSample,
  HistoryDump,
  RequestRecord,
  RequestStats,
  Settings,
  Snapshot,
  SpecStats,
} from '@llama-webui/shared';
import { defer, SERIES, stateHost } from '@llama-webui/shared';
import { fetchLlama, probeUrl } from 'llamacpp-js/client';
import {
  foldRecent,
  kvUsage,
  type LlamaRaw,
  lastRequestStats,
  liveRates,
  mergeRequestStats,
  requestDelta,
  specStats,
} from 'llamacpp-js/metrics';
import { type AmdCard, hiddenAmdReading, suspendedAmdReading } from '../collectors/amdgpu';
import type { DiskSample } from '../collectors/disk';
import { type GpuReading, identityReading, selectUsedGpus } from '../collectors/gpu';
import { gpuNeeds, gpuSkipped } from '../collectors/needs';
import { Collectors } from '../collectors/registry';
import type { SystemSample } from '../collectors/system';
import type { ServerState, Supervisor } from '../supervisor/supervisor';
import { History, historyPoints } from './history';

const MODEL_DISK_RETRY_MS = 30_000;
const APPS_EVERY = 5;

export type MonitorSettings = Pick<Settings, 'collectors' | 'pollIntervalMs' | 'historySeconds' | 'hiddenGpus'>;

function pidOf(s: ServerState): number | null {
  if (s.kind === 'starting' || s.kind === 'ready' || s.kind === 'stopping' || s.kind === 'external') return s.pid;
  return null;
}
const isActive = (s: ServerState) =>
  s.kind === 'starting' || s.kind === 'ready' || s.kind === 'stopping' || s.kind === 'external';

/**
 * Permanent sampling (llama-tui's Poller): one tick every `pollIntervalMs`, whether tabs are open or not. Each tick
 * produces a Snapshot (broadcast to subscribers) and adds a point to every history series.
 * Lives in the runtime (survives a development reload).
 */
export class Monitor {
  private history: History;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private tickNo = 0;
  private prevRaw: LlamaRaw | null = null;
  private prevMetrics: Map<string, number> | null = null;
  private lastPid: number | null = null;
  private ticksForPid = 0;
  private lastRequest: RequestStats | null = null;
  private recentRequests: RequestRecord[] = [];
  private spec: SpecStats | null = null;
  private points: Record<string, number | null> = {};
  private current: Snapshot | null = null;
  private listeners = new Set<(s: Snapshot) => void>();
  private modelPathFor: (profileId: number) => string | null = () => null;
  /** Per profile: the disk its model is read from (null: not found yet) and the time of the last lookup. */
  private modelDisks = new Map<number, { disk: string | null; at: number; pending: boolean }>();

  private constructor(
    private readonly supervisor: Pick<Supervisor, 'state'>,
    private readonly collectors: Collectors,
    private settings: MonitorSettings,
  ) {
    this.history = new History(
      historyPoints(settings.historySeconds, settings.pollIntervalMs),
      settings.pollIntervalMs,
    );
  }

  static async start(deps: { supervisor: Pick<Supervisor, 'state'>; settings: MonitorSettings }): Promise<Monitor> {
    const collectors = await Collectors.start(deps.settings);
    const m = new Monitor(deps.supervisor, collectors, deps.settings);
    void m.tick();
    m.timer = setInterval(() => void m.tick(), deps.settings.pollIntervalMs);
    return m;
  }

  get nvidiaSource(): 'nvml' | 'nvidia-smi' {
    return this.collectors.nvidiaSource;
  }

  get nvmlSystem(): { driver: string | null; cudaDriver: number | null } | null {
    return this.collectors.nvmlSystem;
  }

  /** Absolute model path of a profile (model disk); provided by the server module, which is hot-reloaded. */
  setModelPathResolver(fn: (profileId: number) => string | null): void {
    this.modelPathFor = fn;
    this.modelDisks.clear();
  }

  /**
   * Follows the settings: collectors, history size (recent points kept), interval. The new settings only become
   * current once the collectors accepted them: after a failure, a later call compares against the old ones.
   */
  async configure(next: MonitorSettings): Promise<void> {
    const prev = this.settings;
    await this.collectors.configure(next);
    this.settings = next;
    if (prev.historySeconds !== next.historySeconds || prev.pollIntervalMs !== next.pollIntervalMs) {
      this.history = this.history.resized(historyPoints(next.historySeconds, next.pollIntervalMs), next.pollIntervalMs);
    }
    if (prev.pollIntervalMs !== next.pollIntervalMs && this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.tick(), next.pollIntervalMs);
    }
  }

  latest(): Snapshot | null {
    return this.current;
  }

  dump(): HistoryDump {
    return this.history.dump();
  }

  onSnapshot(fn: (s: Snapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
    this.collectors.stop();
  }

  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    using _tick = defer(() => (this.inFlight = false));
    try {
      const snap = await this.doTick();
      this.current = snap;
      for (const fn of this.listeners) {
        try {
          fn(snap);
        } catch (err) {
          console.error('[llama-webui] monitoring subscriber:', err);
        }
      }
    } catch (err) {
      console.error('[llama-webui] monitoring tick:', err);
    }
  }

  /** Adds the tick's value to a series (NaN = gap) and records it in `points`. */
  private push(key: string, v: number): void {
    this.history.series(key).push(v);
    this.points[key] = Number.isFinite(v) ? v : null;
  }

  /** Adds v only if the series already exists or v is known: a series starts at its first value. */
  private known(key: string, v: number | null | undefined): void {
    if (typeof v === 'number' && Number.isFinite(v)) this.push(key, v);
    else if (this.history.has(key)) this.push(key, NaN);
  }

  private async doTick(): Promise<Snapshot> {
    const at = Date.now();
    const state = this.supervisor.state;
    const pid = pidOf(state);
    this.points = {};
    this.history.tick(at);
    this.tickNo++;

    if (pid !== this.lastPid) {
      // New process (restart, other profile): the counters start over from zero, no delta with the old one.
      this.lastPid = pid;
      this.prevRaw = null;
      this.prevMetrics = null;
      this.ticksForPid = 0;
      this.lastRequest = null;
      this.spec = null;
      this.recentRequests = [];
    }

    const machineP = this.sampleMachine(state);
    const base: Omit<Snapshot, 'points' | 'history'> = {
      at,
      tick: this.tickNo,
      health: null,
      rates: { genTps: 0, ppTps: 0 },
      slots: null,
      kv: null,
      queue: null,
      lastRequest: this.lastRequest,
      spec: this.spec,
      recentRequests: this.recentRequests,
      gpus: [],
      allGpus: [],
      proc: null,
      system: null,
      disk: null,
    };

    this.collectors.memBw?.setPid(pid);
    if (!isActive(state)) {
      const allGpus = await this.collectGpus(null).catch(() => [] as GpuSample[]);
      this.pushGpuSeries(allGpus);
      const machine = await machineP;
      const h = this.history;
      this.push(SERIES.genTps, 0);
      this.push(SERIES.ppTps, 0);
      this.push(SERIES.specAccept, h.series(SERIES.specAccept).last() ?? 0);
      this.push(SERIES.cpuPct, 0);
      this.push(SERIES.kvPct, 0);
      this.push(SERIES.reqProcessing, 0);
      this.push(SERIES.reqDeferred, 0);
      this.push(SERIES.busySlots, 0);
      return this.finish({ ...base, allGpus, ...machine });
    }

    this.ticksForPid++;
    const port = state.port;
    const url = probeUrl(stateHost(state), port);
    const [raw, allGpus, procRaw] = await Promise.all([
      fetchLlama(url).catch(() => null),
      this.collectGpus(pid).catch(() => [] as GpuSample[]),
      pid === null ? Promise.resolve(null) : this.collectors.proc.sample(pid).catch(() => null),
    ]);
    const dramBps = this.collectors.memBw?.procSample() ?? null;
    const proc = procRaw ? { ...procRaw, dramBps } : null;
    this.known(SERIES.procDram, dramBps);

    const rates = raw ? liveRates(this.prevRaw, raw) : { genTps: 0, ppTps: 0 };
    if (raw) this.prevRaw = raw;

    if (raw?.metrics) {
      if (this.prevMetrics) {
        this.lastRequest = mergeRequestStats(this.lastRequest, lastRequestStats(this.prevMetrics, raw.metrics));
        this.recentRequests = foldRecent(this.recentRequests, requestDelta(this.prevMetrics, raw.metrics, at));
      }
      this.spec = specStats(raw.metrics);
      this.prevMetrics = raw.metrics;
    }

    const h = this.history;
    this.push(SERIES.genTps, rates.genTps);
    this.push(SERIES.ppTps, rates.ppTps);
    this.push(SERIES.specAccept, this.lastRequest?.specAccept ?? h.series(SERIES.specAccept).last() ?? 0);
    this.push(SERIES.cpuPct, proc?.cpuPct ?? 0);
    const kv = kvUsage(raw?.slots ?? null);
    const metric = (k: string) => raw?.metrics?.get(`llamacpp:${k}`) ?? 0;
    const queue = raw?.metrics
      ? {
          processing: metric('requests_processing'),
          deferred: metric('requests_deferred'),
          busySlots: metric('n_busy_slots_per_decode'),
        }
      : null;
    this.push(SERIES.kvPct, kv ? (100 * kv.usedTokens) / kv.totalTokens : 0);
    this.push(SERIES.reqProcessing, queue?.processing ?? 0);
    this.push(SERIES.reqDeferred, queue?.deferred ?? 0);
    this.push(SERIES.busySlots, queue?.busySlots ?? 0);
    this.pushGpuSeries(allGpus);
    const gpus = pid === null ? [] : selectUsedGpus(allGpus);

    const machine = await machineP;
    return this.finish({
      ...base,
      health: raw?.health ?? 'down',
      rates,
      slots: raw?.slots ?? null,
      kv,
      queue,
      lastRequest: this.lastRequest,
      spec: this.spec,
      recentRequests: this.recentRequests,
      gpus,
      allGpus,
      proc,
      ...machine,
    });
  }

  /** An existing series not fed on this tick gets a gap: they all move together, aligned on the timestamps. */
  private finish(snap: Omit<Snapshot, 'points' | 'history'>): Snapshot {
    for (const key of this.history.keys()) if (!(key in this.points)) this.push(key, NaN);
    return {
      ...snap,
      points: this.points,
      history: { intervalMs: this.history.intervalMs, capacity: this.history.capacity },
    };
  }

  /** Series of every GPU in the machine, whether the server uses it or not. */
  private pushGpuSeries(all: GpuSample[]): void {
    for (const g of all) {
      this.push(SERIES.gpuUtil(g.key), g.suspended || g.hidden ? NaN : (g.utilPct ?? 0));
      this.known(SERIES.gpuVramPct(g.key), g.vramTotalBytes > 0 ? (100 * g.vramUsedBytes) / g.vramTotalBytes : null);
      this.known(SERIES.gpuPcieRx(g.key), g.pcieRxBps);
      this.known(SERIES.gpuPcieTx(g.key), g.pcieTxBps);
      this.known(SERIES.gpuPower(g.key), g.powerW);
      this.known(SERIES.gpuTemp(g.key), g.tempC);
    }
  }

  /** CPU/memory and disks with their series; never throws. Collector off: gap in its series. */
  private async sampleMachine(state: ServerState): Promise<{ system: SystemSample | null; disk: DiskSample | null }> {
    const sys = this.collectors.system;
    const dsk = this.collectors.disk;
    const [system, disk] = await Promise.all([
      sys ? sys.sample().catch(() => null) : Promise.resolve(null),
      dsk ? dsk.sample(this.modelDiskFor(state)).catch(() => null) : Promise.resolve(null),
    ]);
    if (sys) {
      const memBw = this.collectors.memBw?.sample() ?? null;
      if (system) system.memBw = memBw;
      this.known(SERIES.memRead, memBw?.readBps);
      this.known(SERIES.memWrite, memBw?.writeBps);
      this.push(SERIES.sysCpu, system?.cpuPct ?? 0);
      const mem = system?.mem;
      this.push(
        SERIES.sysMemPct,
        mem && mem.totalBytes > 0 ? (100 * (mem.totalBytes - mem.availableBytes)) / mem.totalBytes : 0,
      );
      this.known(SERIES.sysTemp, system?.tempC);
    }
    if (dsk) {
      this.push(SERIES.diskRead, disk?.readBps ?? 0);
      this.push(SERIES.diskWrite, disk?.writeBps ?? 0);
      this.push(SERIES.modelDiskRead, disk?.model?.readBps ?? 0);
    }
    return { system, disk };
  }

  /**
   * Model disk of the current profile; null for an external server and until the lookup has succeeded.
   * The lookup runs in the background, once per profile: a stat on a dead NFS mount must never block a tick.
   */
  private modelDiskFor(state: ServerState): string | null {
    const disk = this.collectors.disk;
    if (!disk || !('profileId' in state) || state.kind === 'crashed') return null;
    const id = state.profileId;
    const now = Date.now();
    const known = this.modelDisks.get(id);
    if (!known || (known.disk === null && !known.pending && now - known.at >= MODEL_DISK_RETRY_MS)) {
      const path = this.modelPathFor(id);
      this.modelDisks.set(id, { disk: null, at: now, pending: path !== null });
      if (path) {
        void Promise.resolve()
          .then(() => disk.resolveModelDisk(path))
          .then(
            (d) => this.modelDisks.set(id, { disk: d, at: now, pending: false }),
            () => this.modelDisks.set(id, { disk: null, at: now, pending: false }),
          );
      }
    }
    return this.modelDisks.get(id)?.disk ?? null;
  }

  /**
   * All GPUs, sorted by busId; process VRAM only with a pid. Hidden cards are listed without being
   * read; a suspended AMD card is not read (reading it would wake it up).
   */
  private async collectGpus(pid: number | null): Promise<GpuSample[]> {
    const { nvidia, amd } = this.collectors;
    const n = gpuNeeds(this.settings.hiddenGpus);
    if (pid !== null) {
      if (this.ticksForPid === 1) await nvidia.refreshApps().catch(() => {});
      else if (this.ticksForPid % APPS_EVERY === 0) void nvidia.refreshApps().catch(() => {});
    }
    // Hidden or suspended cards: neither sysfs nor fdinfo (their DRM nodes are skipped in /proc/<pid>/fd).
    const skipNodes = new Set<string>();
    const readAmd = async (c: AmdCard): Promise<GpuReading | null> => {
      const skip = (r: GpuReading) => {
        for (const node of c.nodes ?? []) skipNodes.add(node);
        return r;
      };
      if (gpuSkipped(n, c.pdev)) return skip(hiddenAmdReading(c));
      if (await amd.suspended(c).catch(() => false)) return skip(suspendedAmdReading(c));
      return amd.read(c).catch(() => null);
    };
    const amdReadings = await Promise.all(amd.cards().map(readAmd));
    const amdProc =
      pid === null
        ? new Map<string, number>()
        : await amd.procVram(pid, skipNodes).catch(() => new Map<string, number>());
    const nvProc = pid === null ? new Map<string, number>() : nvidia.procVram(pid);
    const readings = [
      ...nvidia.gpus().map((g) => ({ g, proc: nvProc })),
      ...amdReadings.flatMap((g) => (g ? [{ g, proc: amdProc }] : [])),
    ];
    const all = readings.map(({ g, proc }): GpuSample => {
      if (gpuSkipped(n, g.busId)) return { ...identityReading(g, 'hidden'), procVramBytes: 0 };
      if (g.suspended) return { ...g, procVramBytes: 0 };
      return { ...g, procVramBytes: proc.get(g.key) ?? 0 };
    });
    return all.sort((a, b) => a.busId.localeCompare(b.busId));
  }
}
