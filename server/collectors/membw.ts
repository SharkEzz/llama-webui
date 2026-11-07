import type { MemBandwidth } from '@llama-webui/shared';

/*
 * Bande passante DRAM par `perf stat`, sans root quand perf_event_paranoid ≤ 0 (ou CAP_PERFMON sur perf) :
 * - système entier : PMU du contrôleur mémoire AMD (`umc_cas_cmd.rd/wr`, une commande CAS = 64 octets), qui voit tout
 *   ce qui touche la DRAM (CPU, DMA des GPU en PCIe, NVMe) ;
 * - llama-server seul : événement cœur `ls_any_fills_from_sys.dram_io_all` (lignes de 64 octets ramenées de la DRAM),
 *   attaché à son PID.
 * Tout échec (perf absent, événement inconnu sur ce CPU, droits insuffisants) dégrade en « inconnu ».
 */

type Spawned = {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
};

export const SYSTEM_EVENTS = { read: 'umc_cas_cmd.rd', write: 'umc_cas_cmd.wr' } as const;
export const PROC_EVENT = 'ls_any_fills_from_sys.dram_io_all';
/** Une commande CAS ou un remplissage de ligne = 64 octets. */
export const BYTES_PER_EVENT = 64;
/** Après un échec, nouvel essai au plus tôt après ce délai (pas de boucle de spawn). */
const RETRY_MS = 60_000;

export interface PerfLine {
  /** Secondes depuis le lancement de perf. */
  time: number;
  /** null : « <not supported> » ou « <not counted> ». */
  count: number | null;
  event: string;
}

/** Ligne CSV de `perf stat -I … -x,` : « 1.005,1072663,,umc_cas_cmd.rd,2010102242,100,00,, ». */
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

/** Un `perf stat` qui tourne : débit (événements/s) par événement, d'après le compte de chaque intervalle. */
class PerfStream {
  private proc: Spawned | null = null;
  private prevTime = new Map<string, number>();
  private rates = new Map<string, number>();
  private lastAt = 0;
  /** Moment où perf s'est arrêté (ou a refusé de démarrer) ; null tant qu'il tourne ou s'il a été arrêté par stop(). */
  diedAt: number | null = null;
  /** perf a refusé de démarrer ou s'est arrêté sans jamais rien donner. */
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
      // flux coupé : on garde les dernières valeurs, elles périmeront
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

  /** Débit d'un événement (par seconde) s'il a été mis à jour il y a moins de `maxAgeMs`. */
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

export class MemBandwidthSampler {
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

  /** Un flux mort peut être relancé : RETRY_MS après sa mort (pas de boucle de spawn si perf échoue à chaque fois). */
  private canRetry(s: PerfStream): boolean {
    return s.diedAt !== null && this.now() - s.diedAt >= RETRY_MS;
  }

  /** Lance la mesure système (idempotent) ; si perf s'arrête, le relance au plus toutes les `RETRY_MS`. */
  start(): void {
    const s = this.system;
    if (s && !this.canRetry(s)) return;
    s?.stop();
    this.system = this.stream(['-a', '-e', `${SYSTEM_EVENTS.read},${SYSTEM_EVENTS.write}`]);
  }

  /** Nouvelle cadence : les flux repartent (perf fixe son intervalle au lancement). */
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
   * Process à suivre (llama-server) ; null : aucun. Appelé à chaque tick : un PID auquel perf n'a jamais pu s'attacher
   * n'est pas réessayé, un flux mort après avoir donné des valeurs est relancé au plus toutes les `RETRY_MS`.
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

  /** Bande passante DRAM de la machine ; null si perf ne la donne pas (ou plus). */
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

  /** Octets/s ramenés de la DRAM par le process suivi ; null si inconnu. */
  procSample(): number | null {
    const p = this.proc;
    if (!p || p.dead) return null;
    const r = p.rate(PROC_EVENT, this.maxAgeMs);
    return r === null ? null : r * BYTES_PER_EVENT;
  }

  /** La mesure système a déjà donné des valeurs (affiché dans Système). */
  get available(): boolean {
    return Boolean(this.system?.gotData && !this.system.dead);
  }

  stop(): void {
    this.system?.stop();
    this.system = null;
    this.proc?.stop();
    this.proc = null;
    this.procPid = null;
  }
}
