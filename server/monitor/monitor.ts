import type { GpuSample, HistoryDump, RequestRecord, RequestStats, Settings, Snapshot, SpecStats } from "@llama-webui/shared";
import { SERIES } from "@llama-webui/shared";
import { type AmdCard, hiddenAmdReading, suspendedAmdReading } from "../collectors/amdgpu";
import type { DiskSample } from "../collectors/disk";
import { type GpuReading, identityReading, selectUsedGpus } from "../collectors/gpu";
import {
  fetchLlama,
  foldRecent,
  kvUsage,
  type LlamaRaw,
  lastRequestStats,
  liveRates,
  mergeRequestStats,
  requestDelta,
  specStats,
} from "../collectors/llama";
import { gpuNeeds, gpuSkipped } from "../collectors/needs";
import { Collectors } from "../collectors/registry";
import type { SystemSample } from "../collectors/system";
import type { ServerState, Supervisor } from "../supervisor/supervisor";
import { History, historyPoints } from "./history";

const MODEL_DISK_RETRY_MS = 30_000;
const APPS_EVERY = 5;

export type MonitorSettings = Pick<Settings, "collectors" | "pollIntervalMs" | "historySeconds" | "hiddenGpus">;

function pidOf(s: ServerState): number | null {
  if (s.kind === "starting" || s.kind === "ready" || s.kind === "stopping" || s.kind === "external") return s.pid;
  return null;
}
const isActive = (s: ServerState) => s.kind === "starting" || s.kind === "ready" || s.kind === "stopping" || s.kind === "external";

/**
 * Échantillonnage permanent (le Poller de llama-tui) : un tick toutes les `pollIntervalMs`, que des onglets soient
 * ouverts ou non. Chaque tick produit un Snapshot (diffusé aux abonnés) et ajoute un point à chaque série de l'historique.
 * Vit dans le runtime (survit à bun --hot).
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
  /** Par profil : le disque d'où son modèle est lu (null : pas encore trouvé) et l'heure de la dernière recherche. */
  private modelDisks = new Map<number, { disk: string | null; at: number; pending: boolean }>();

  private constructor(
    private readonly supervisor: Pick<Supervisor, "state">,
    private readonly collectors: Collectors,
    private settings: MonitorSettings,
  ) {
    this.history = new History(historyPoints(settings.historySeconds, settings.pollIntervalMs), settings.pollIntervalMs);
  }

  static async start(deps: { supervisor: Pick<Supervisor, "state">; settings: MonitorSettings }): Promise<Monitor> {
    const collectors = await Collectors.start(deps.settings);
    const m = new Monitor(deps.supervisor, collectors, deps.settings);
    void m.tick();
    m.timer = setInterval(() => void m.tick(), deps.settings.pollIntervalMs);
    return m;
  }

  get nvidiaSource(): "nvml" | "nvidia-smi" {
    return this.collectors.nvidiaSource;
  }

  /** Chemin absolu du modèle d'un profil (disque du modèle) ; fourni par le module serveur, rechargé à chaud. */
  setModelPathResolver(fn: (profileId: number) => string | null): void {
    this.modelPathFor = fn;
    this.modelDisks.clear();
  }

  /** Suit les réglages : collecteurs, taille de l'historique (points récents gardés), cadence. */
  async configure(next: MonitorSettings): Promise<void> {
    const prev = this.settings;
    this.settings = next;
    await this.collectors.configure(next);
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
    try {
      const snap = await this.doTick();
      this.current = snap;
      for (const fn of this.listeners) {
        try {
          fn(snap);
        } catch (err) {
          console.error("[llama-webui] abonné du monitoring :", err);
        }
      }
    } catch (err) {
      console.error("[llama-webui] tick de monitoring :", err);
    } finally {
      this.inFlight = false;
    }
  }

  /** Ajoute la valeur du tick à une série (NaN = trou) et la note dans `points`. */
  private push(key: string, v: number): void {
    this.history.series(key).push(v);
    this.points[key] = Number.isFinite(v) ? v : null;
  }

  /** Ajoute v seulement si la série existe déjà ou si v est connu : une série commence à sa première valeur. */
  private known(key: string, v: number | null | undefined): void {
    if (typeof v === "number" && Number.isFinite(v)) this.push(key, v);
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
      // Nouveau process (redémarrage, autre profil) : les compteurs repartent de zéro, pas de delta avec l'ancien.
      this.lastPid = pid;
      this.prevRaw = null;
      this.prevMetrics = null;
      this.ticksForPid = 0;
      this.lastRequest = null;
      this.spec = null;
      this.recentRequests = [];
    }

    const machineP = this.sampleMachine(state);
    const base: Omit<Snapshot, "points"> = {
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
    const url = `http://127.0.0.1:${port}`;
    const [raw, allGpus, proc] = await Promise.all([
      fetchLlama(url).catch(() => null),
      this.collectGpus(pid).catch(() => [] as GpuSample[]),
      pid === null ? Promise.resolve(null) : this.collectors.proc.sample(pid).catch(() => null),
    ]);

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
      ? { processing: metric("requests_processing"), deferred: metric("requests_deferred"), busySlots: metric("n_busy_slots_per_decode") }
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
      health: raw?.health ?? "down",
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

  /** Une série existante non alimentée à ce tick reçoit un trou : toutes avancent ensemble, alignées sur les instants. */
  private finish(snap: Omit<Snapshot, "points">): Snapshot {
    for (const key of this.history.keys()) if (!(key in this.points)) this.push(key, NaN);
    return { ...snap, points: this.points };
  }

  /** Séries de chaque GPU de la machine, utilisée ou non par le serveur. */
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

  /** CPU/mémoire et disques avec leurs séries ; ne lève jamais. Collecteur coupé : trou dans ses séries. */
  private async sampleMachine(state: ServerState): Promise<{ system: SystemSample | null; disk: DiskSample | null }> {
    const sys = this.collectors.system;
    const dsk = this.collectors.disk;
    const [system, disk] = await Promise.all([
      sys ? sys.sample().catch(() => null) : Promise.resolve(null),
      dsk ? dsk.sample(this.modelDiskFor(state)).catch(() => null) : Promise.resolve(null),
    ]);
    if (sys) {
      this.push(SERIES.sysCpu, system?.cpuPct ?? 0);
      const mem = system?.mem;
      this.push(SERIES.sysMemPct, mem && mem.totalBytes > 0 ? (100 * (mem.totalBytes - mem.availableBytes)) / mem.totalBytes : 0);
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
   * Disque du modèle du profil en cours ; null pour un serveur externe et tant que la recherche n'a pas abouti.
   * La recherche tourne en tâche de fond, une fois par profil : un stat sur un montage NFS mort ne doit jamais bloquer un tick.
   */
  private modelDiskFor(state: ServerState): string | null {
    const disk = this.collectors.disk;
    if (!disk || !("profileId" in state) || state.kind === "crashed") return null;
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
   * Toutes les GPU, triées par busId ; VRAM du process seulement avec un pid. Les cartes masquées sont listées
   * sans être lues ; une carte AMD en veille n'est pas lue (la lecture la réveillerait).
   */
  private async collectGpus(pid: number | null): Promise<GpuSample[]> {
    const { nvidia, amd } = this.collectors;
    const n = gpuNeeds(this.settings.hiddenGpus);
    if (pid !== null) {
      if (this.ticksForPid === 1) await nvidia.refreshApps().catch(() => {});
      else if (this.ticksForPid % APPS_EVERY === 0) void nvidia.refreshApps().catch(() => {});
    }
    const readAmd = async (c: AmdCard): Promise<GpuReading | null> => {
      if (gpuSkipped(n, c.pdev)) return hiddenAmdReading(c);
      if (await amd.suspended(c).catch(() => false)) return suspendedAmdReading(c);
      return amd.read(c).catch(() => null);
    };
    const [amdReadings, amdProc] = await Promise.all([
      Promise.all(amd.cards().map(readAmd)),
      pid === null ? new Map<string, number>() : amd.procVram(pid).catch(() => new Map<string, number>()),
    ]);
    const nvProc = pid === null ? new Map<string, number>() : nvidia.procVram(pid);
    const readings = [...nvidia.gpus().map((g) => ({ g, proc: nvProc })), ...amdReadings.flatMap((g) => (g ? [{ g, proc: amdProc }] : []))];
    const all = readings.map(({ g, proc }): GpuSample => {
      if (gpuSkipped(n, g.busId)) return { ...identityReading(g, "hidden"), procVramBytes: 0 };
      return { ...g, procVramBytes: proc.get(g.key) ?? 0 };
    });
    return all.sort((a, b) => a.busId.localeCompare(b.busId));
  }
}
