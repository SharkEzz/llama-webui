import type { MemBandwidth } from '@llama-webui/shared';

/*
 * DRAM bandwidth through `perf stat`, without root when perf_event_paranoid ≤ 0 (or CAP_PERFMON on perf):
 * - whole system: AMD memory controller PMU (`umc_cas_cmd.rd/wr`, one CAS command = 64 bytes), which sees everything
 *   that touches DRAM (CPU, GPU DMA over PCIe, NVMe);
 * - llama-server alone: core event `ls_any_fills_from_sys.dram_io_all` (64-byte lines fetched from DRAM),
 *   attached to its PID.
 * Any failure (perf missing, event unknown on this CPU, insufficient permissions) degrades to “unknown”.
 */

type Spawned = {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
};

export const SYSTEM_EVENTS = { read: 'umc_cas_cmd.rd', write: 'umc_cas_cmd.wr' } as const;
export const PROC_EVENT = 'ls_any_fills_from_sys.dram_io_all';
/** One CAS command or one line fill = 64 bytes. */
export const BYTES_PER_EVENT = 64;
/** After a failure, retry no sooner than this delay (no spawn loop). */
const RETRY_MS = 60_000;

export interface PerfLine {
  /** Seconds since perf was started. */
  time: number;
  /** null: “<not supported>” or “<not counted>”. */
  count: number | null;
  event: string;
}

/** CSV line of `perf stat -I … -x,`: “1.005,1072663,,umc_cas_cmd.rd,2010102242,100,00,,”. */
export function parsePerfLine(line: string): PerfLine | null {
  const f = line.split(',');
  if (f.length < 4) return null;
  const time = Number(f[0]);
  if (!Number.isFinite(time)) return null;
  const event = f[3]!.trim();
  if (!event) return null;
  const n = Number(f[1]);
  return { time, count: f[1]!.startsWith('<') || !Number.isFinite(n) ? null : n, event };
}

interface StreamOptions {
  bin: string;
  args: string[];
  spawn: typeof Bun.spawn;
  now: () => number;
}

/** A running `perf stat`: rate (events/s) per event, from each interval's count. */
class PerfStream {
  private proc: Spawned | null = null;
  private prevTime = new Map<string, number>();
  private rates = new Map<string, number>();
  private lastAt = 0;
  /** When perf exited (or refused to start); null while it runs or if it was stopped by stop(). */
  diedAt: number | null = null;
  /** perf refused to start or exited without ever reporting anything. */
  failed = false;
  gotData = false;

  constructor(private readonly o: StreamOptions) {}

  start(): void {
    if (this.proc) return;
    try {
      this.proc = this.o.spawn([this.o.bin, 'stat', ...this.o.args, '-x', ',', '--log-fd', '1'], {
        stdout: 'pipe',
        stderr: 'ignore',
        stdin: 'ignore',
      }) as unknown as Spawned;
    } catch {
      this.die();
      return;
    }
    void this.read(this.proc);
  }

  private async read(proc: Spawned) {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of proc.stdout) {
        if (this.proc !== proc) return;
        buf += decoder.decode(chunk, { stream: true });
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          this.onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
    } catch {
      // stream cut: keep the last values, they will go stale
    }
    if (this.proc !== proc) return;
    this.proc = null;
    this.die();
  }

  private die() {
    this.diedAt = this.o.now();
    this.failed = !this.gotData;
  }

  get dead(): boolean {
    return this.diedAt !== null;
  }

  private onLine(line: string) {
    const p = parsePerfLine(line);
    if (!p) return;
    this.gotData = true;
    const dt = p.time - (this.prevTime.get(p.event) ?? 0);
    this.prevTime.set(p.event, p.time);
    if (p.count === null || dt <= 0) this.rates.delete(p.event);
    else this.rates.set(p.event, p.count / dt);
    this.lastAt = this.o.now();
  }

  /** Rate of an event (per second) if it was updated less than `maxAgeMs` ago. */
  rate(event: string, maxAgeMs: number): number | null {
    if (this.o.now() - this.lastAt > maxAgeMs) return null;
    return this.rates.get(event) ?? null;
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    try {
      p?.kill();
    } catch {}
  }
}

export interface MemBandwidthOptions {
  bin?: string;
  intervalMs?: number;
  spawn?: typeof Bun.spawn;
  now?: () => number;
}

export class MemBandwidthSampler implements Disposable {
  private readonly bin: string;
  private intervalMs: number;
  private readonly spawn: typeof Bun.spawn;
  private readonly now: () => number;
  private system: PerfStream | null = null;
  private proc: PerfStream | null = null;
  private procPid: number | null = null;

  constructor(o: MemBandwidthOptions = {}) {
    this.bin = o.bin ?? 'perf';
    this.intervalMs = o.intervalMs ?? 1000;
    this.spawn = o.spawn ?? Bun.spawn;
    this.now = o.now ?? Date.now;
  }

  private stream(args: string[]): PerfStream {
    const s = new PerfStream({
      bin: this.bin,
      args: [...args, '-I', String(this.intervalMs)],
      spawn: this.spawn,
      now: this.now,
    });
    s.start();
    return s;
  }

  /** A dead stream can be restarted RETRY_MS after it died (no spawn loop if perf fails every time). */
  private canRetry(s: PerfStream): boolean {
    return s.diedAt !== null && this.now() - s.diedAt >= RETRY_MS;
  }

  /** Starts the system measurement (idempotent); if perf exits, restarts it at most every `RETRY_MS`. */
  start(): void {
    const s = this.system;
    if (s && !this.canRetry(s)) return;
    s?.stop();
    this.system = this.stream(['-a', '-e', `${SYSTEM_EVENTS.read},${SYSTEM_EVENTS.write}`]);
  }

  /** New interval: the streams restart (perf sets its interval at launch). */
  configure(intervalMs: number): void {
    if (intervalMs === this.intervalMs) return;
    this.intervalMs = intervalMs;
    this.system?.stop();
    this.system = null;
    const pid = this.procPid;
    this.setPid(null);
    this.start();
    this.setPid(pid);
  }

  /**
   * Process to follow (llama-server); null: none. Called on every tick: a PID perf could never attach to is not
   * retried, a stream that died after reporting values is restarted at most every `RETRY_MS`.
   */
  setPid(pid: number | null): void {
    if (pid !== this.procPid) {
      this.proc?.stop();
      this.proc = null;
      this.procPid = pid;
    }
    const p = this.proc;
    if (pid === null || (p && (p.failed || !this.canRetry(p)))) return;
    p?.stop();
    this.proc = this.stream(['-p', String(pid), '-e', PROC_EVENT]);
  }

  private get maxAgeMs(): number {
    return this.intervalMs * 3;
  }

  /** Machine DRAM bandwidth; null if perf doesn't report it (or no longer does). */
  sample(): MemBandwidth | null {
    const s = this.system;
    if (!s) return null;
    if (s.dead) {
      this.start();
      return null;
    }
    const read = s.rate(SYSTEM_EVENTS.read, this.maxAgeMs);
    const write = s.rate(SYSTEM_EVENTS.write, this.maxAgeMs);
    if (read === null && write === null) return null;
    return { readBps: (read ?? 0) * BYTES_PER_EVENT, writeBps: (write ?? 0) * BYTES_PER_EVENT };
  }

  /** Bytes/s fetched from DRAM by the followed process; null if unknown. */
  procSample(): number | null {
    const p = this.proc;
    if (!p || p.dead) return null;
    const r = p.rate(PROC_EVENT, this.maxAgeMs);
    return r === null ? null : r * BYTES_PER_EVENT;
  }

  stop(): void {
    this.system?.stop();
    this.system = null;
    this.proc?.stop();
    this.proc = null;
    this.procPid = null;
  }

  /** `using s = new MemBandwidthSampler()`: the perf processes are stopped when leaving the scope. */
  [Symbol.dispose](): void {
    this.stop();
  }
}
