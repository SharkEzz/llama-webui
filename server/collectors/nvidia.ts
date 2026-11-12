import { type Spawn, spawnProc } from '../proc';
import { type GpuReading, normalizeBusId } from './gpu';

const MiB = 1024 ** 2;
const QUERY = 'index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,pci.bus_id';

const numOrNull = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number(s.trim());
  return s.trim() === '' || !Number.isFinite(n) ? null : n;
};

export function parseNvidiaGpuLine(line: string): GpuReading | null {
  const f = line.split(',').map((x) => x.trim());
  if (f.length < 9) return null;
  const [, uuid, name, util, used, total, temp, power, bus] = f as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const usedN = numOrNull(used);
  const totalN = numOrNull(total);
  if (!uuid.startsWith('GPU-') || usedN === null || totalN === null) return null;
  return {
    key: `nvidia:${uuid}`,
    vendor: 'nvidia',
    name,
    busId: normalizeBusId(bus),
    utilPct: numOrNull(util),
    vramUsedBytes: usedN * MiB,
    vramTotalBytes: totalN * MiB,
    tempC: numOrNull(temp),
    powerW: numOrNull(power),
  };
}

/** usedBytes null: the driver reports "[N/A]" (the process is on the card, its share unknown). */
export function parseComputeApps(csv: string): Array<{ pid: number; uuid: string; usedBytes: number | null }> {
  const out: Array<{ pid: number; uuid: string; usedBytes: number | null }> = [];
  for (const line of csv.split('\n')) {
    const [pid, uuid, used] = line.split(',').map((x) => x.trim());
    const p = Number(pid),
      u = Number(used);
    if (!uuid || !Number.isFinite(p) || pid === '') continue;
    if (Number.isFinite(u) && used !== '') out.push({ pid: p, uuid, usedBytes: u * MiB });
    else if (used === '[N/A]' || used === 'N/A') out.push({ pid: p, uuid, usedBytes: null });
  }
  return out;
}

type Spawned = {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
};

/** `reached` resolves to null after `ms`; the timer is cleared when leaving the scope (`using`). */
function timeoutAfter(ms: number): { reached: Promise<null> } & Disposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return { reached, [Symbol.dispose]: () => clearTimeout(timer) };
}

/** One long-lived `nvidia-smi -lms` stream + occasional compute-apps query. */
export class NvidiaMonitor {
  private bin: string;
  private intervalMs: number;
  private spawn: Spawn;
  private proc: Spawned | null = null;
  private current: GpuReading[] = [];
  private pending: GpuReading[] = [];
  private apps: Array<{ pid: number; uuid: string; usedBytes: number | null }> = [];
  private disabled = false;
  private appsTimeoutMs: number;
  private appsInFlight: Promise<void> | null = null;

  constructor(opts: { bin?: string; intervalMs?: number; spawn?: Spawn; appsTimeoutMs?: number } = {}) {
    this.appsTimeoutMs = opts.appsTimeoutMs ?? 3000;
    this.bin = opts.bin ?? 'nvidia-smi';
    this.intervalMs = opts.intervalMs ?? 1000;
    this.spawn = opts.spawn ?? spawnProc;
  }

  start(): void {
    if (this.proc || this.disabled) return;
    try {
      this.proc = this.spawn(
        [this.bin, `--query-gpu=${QUERY}`, '--format=csv,noheader,nounits', '-lms', String(this.intervalMs)],
        {
          stdout: 'pipe',
          stderr: 'ignore',
          stdin: 'ignore',
        },
      ) as unknown as Spawned;
    } catch {
      this.disabled = true;
      return;
    }
    void this.read(this.proc);
  }

  private async read(proc: Spawned) {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of proc.stdout) {
        if (this.proc !== proc) return; // replaced (new interval) or stopped: its last lines would mix with the next stream's
        buf += decoder.decode(chunk, { stream: true });
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          this.onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      if (this.proc !== proc) return;
      if (buf.trim()) this.onLine(buf);
      this.flushPending();
    } catch {
      // stream died: keep last values
    }
  }

  private onLine(line: string) {
    const g = parseNvidiaGpuLine(line);
    if (!g) return;
    // A new cycle starts when a key repeats within the pending set.
    if (this.pending.some((p) => p.key === g.key)) this.flushPending();
    this.pending.push(g);
    if (this.current.length > 0 && this.pending.length >= this.current.length) this.flushPending();
  }

  private flushPending() {
    if (this.pending.length === 0) return;
    this.current = this.pending;
    this.pending = [];
  }

  stop(): void {
    try {
      this.proc?.kill();
    } catch {}
    this.proc = null;
  }

  /**
   * A new interval restarts the stream at that pace. Every card is still queried: one nvidia-smi call
   * reads them all, and it reads no PCIe throughput, so the poller just drops what no tab shows.
   */
  configure(o: { intervalMs: number }): void {
    if (o.intervalMs === this.intervalMs) return;
    this.intervalMs = o.intervalMs;
    if (!this.proc) return;
    this.stop();
    this.start();
  }

  gpus(): GpuReading[] {
    if (this.current.length === 0 && this.pending.length > 0) return this.pending;
    return this.current;
  }

  /** One query at a time; a hung nvidia-smi (driver fault) is killed after appsTimeoutMs. */
  refreshApps(): Promise<void> {
    if (this.disabled) return Promise.resolve();
    this.appsInFlight ??= this.queryApps().finally(() => (this.appsInFlight = null));
    return this.appsInFlight;
  }

  private async queryApps(): Promise<void> {
    let p: Spawned;
    try {
      p = this.spawn([this.bin, '--query-compute-apps=pid,gpu_uuid,used_memory', '--format=csv,noheader,nounits'], {
        stdout: 'pipe',
        stderr: 'ignore',
        stdin: 'ignore',
      }) as unknown as Spawned;
    } catch {
      this.disabled = true;
      return;
    }
    using deadline = timeoutAfter(this.appsTimeoutMs);
    // Abandoned on timeout: a pipe torn down by the kill may reject it later, which must not reach the process.
    const read = new Response(p.stdout).text();
    read.catch(() => {});
    try {
      const text = await Promise.race([read, deadline.reached]);
      if (text === null) {
        try {
          p.kill('SIGKILL');
        } catch {}
        return; // keep the previous mapping
      }
      await p.exited;
      this.apps = parseComputeApps(text);
    } catch {
      // transient read failure: keep the previous mapping
    }
  }

  procVram(pid: number): Map<string, number> {
    const m = new Map<string, number>();
    const unknown = new Set<string>();
    for (const a of this.apps) {
      if (a.pid !== pid) continue;
      const k = `nvidia:${a.uuid}`;
      if (a.usedBytes === null) unknown.add(k);
      else m.set(k, (m.get(k) ?? 0) + a.usedBytes);
    }
    // Share unknown: count the card's VRAM in use (an upper bound) so the card still shows as used.
    for (const k of unknown) m.set(k, this.gpus().find((g) => g.key === k)?.vramUsedBytes ?? m.get(k) ?? 0);
    return m;
  }
}
