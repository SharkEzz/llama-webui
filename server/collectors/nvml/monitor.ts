import type { GpuReading } from '../gpu';
import type { GpuNeeds } from '../needs';
import type { NvmlProc, NvmlSnapshot, NvmlSystem } from './read';

export interface WorkerLike {
  postMessage(m: unknown): void;
  terminate(): void;
  unref?(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

type WorkerMsg = { type: 'ready' } | { type: 'error'; message: string } | { type: 'sample'; snapshot: NvmlSnapshot };

/** The worker, next to this module. */
export const workerUrl = (): string => new URL('./worker.ts', import.meta.url).href;

const defaultWorker = (): WorkerLike => {
  const w = new Worker(workerUrl()) as unknown as WorkerLike;
  w.unref?.(); // Bun-specific: never keep the TUI alive
  return w;
};

/** NVIDIA readings from NVML in a Worker; same surface as NvidiaMonitor (gpus/procVram/refreshApps/stop). */
export class NvmlMonitor {
  private current: GpuReading[] = [];
  private procs: NvmlProc[] = [];
  private sys: NvmlSystem | null = null;
  private lastSampleAt = 0;
  /** Interval used to judge freshness: the old one stays valid until the worker has sampled at the new one. */
  private freshIntervalMs: number;

  private constructor(
    private worker: WorkerLike,
    private intervalMs: number,
    private now: () => number,
  ) {
    this.freshIntervalMs = intervalMs;
  }

  /** Driver versions from the last sample; null before the first one. */
  get system(): NvmlSystem | null {
    return this.sys;
  }

  /** Resolves null when NVML is unusable here, so the caller can fall back to nvidia-smi. */
  static start(o: {
    intervalMs: number;
    /** What to read; everything when absent. */
    needs?: GpuNeeds;
    createWorker?: () => WorkerLike;
    readyTimeoutMs?: number;
    now?: () => number;
  }): Promise<NvmlMonitor | null> {
    let worker: WorkerLike;
    try {
      worker = (o.createWorker ?? defaultWorker)();
    } catch {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let monitor: NvmlMonitor | null = null;
      const giveUp = () => {
        clearTimeout(timer);
        try {
          worker.terminate();
        } catch {}
        if (monitor) monitor.clear();
        else resolve(null);
      };
      const timer = setTimeout(giveUp, o.readyTimeoutMs ?? 3000);
      worker.onerror = giveUp;
      worker.onmessage = (e) => {
        const m = e.data as WorkerMsg;
        if (m?.type === 'ready' && !monitor) {
          clearTimeout(timer);
          monitor = new NvmlMonitor(worker, o.intervalMs, o.now ?? Date.now);
          resolve(monitor);
        } else if (m?.type === 'sample' && monitor) {
          monitor.current = m.snapshot.gpus;
          monitor.procs = m.snapshot.procs;
          monitor.sys = m.snapshot.system ?? monitor.sys;
          monitor.lastSampleAt = monitor.now();
          monitor.freshIntervalMs = monitor.intervalMs;
        } else if (m?.type === 'error') {
          giveUp();
        }
      };
      worker.postMessage({ type: 'start', intervalMs: o.intervalMs, ...(o.needs ? { needs: o.needs } : {}) });
    });
  }

  /** New sampling interval and what to read, from the next round on. */
  configure(o: { intervalMs: number; needs: GpuNeeds }): void {
    this.intervalMs = o.intervalMs;
    // The round the worker already scheduled still runs at the old interval: don't mark stale what it is about to replace.
    this.freshIntervalMs = Math.max(this.freshIntervalMs, o.intervalMs);
    this.worker.postMessage({ type: 'configure', intervalMs: o.intervalMs, needs: o.needs });
  }

  private clear() {
    this.current = [];
    this.procs = [];
  }

  /** A worker stuck in an NVML call (driver fault) stops sampling: old numbers must not pass for live ones. */
  private fresh(): boolean {
    return this.now() - this.lastSampleAt <= 3 * this.freshIntervalMs;
  }

  gpus(): GpuReading[] {
    return this.fresh() ? this.current : [];
  }

  procVram(pid: number): Map<string, number> {
    const m = new Map<string, number>();
    if (!this.fresh()) return m;
    const unknown = new Set<string>();
    for (const p of this.procs) {
      if (p.pid !== pid) continue;
      if (p.usedBytes === null) unknown.add(p.key);
      else m.set(p.key, (m.get(p.key) ?? 0) + p.usedBytes);
    }
    // The process is on the card but NVML cannot say how much it holds: count the card's VRAM in use
    // (an upper bound), so the card still shows as used by the server.
    for (const key of unknown) m.set(key, this.current.find((g) => g.key === key)?.vramUsedBytes ?? m.get(key) ?? 0);
    return m;
  }

  /** Processes arrive with every sample. */
  refreshApps(): Promise<void> {
    return Promise.resolve();
  }

  stop(): void {
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.clear();
    try {
      this.worker.terminate();
    } catch {}
  }
}
