import { dirname } from 'node:path';
import {
  type BenchLive,
  type BenchRun,
  type BenchSpec,
  benchArgs,
  defer,
  type GpuSample,
  type Profile,
  type Settings,
  serverArgs,
  shellQuote,
} from '@llama-webui/shared';
import { parseBenchJson, parseBenchProgress } from 'llamacpp-js/bench';
import { benchBinary } from 'llamacpp-js/node';
import type { BenchFinish } from '../db/benchRuns';
import type { LogBuffer } from '../logs/buffer';
import { LineSplitter } from '../logs/lines';
import { fileExists, type Spawned, spawnProc } from '../proc';
import { type BuiltCommand, binaryPath, buildCommand } from '../supervisor/args';
import { benchFailure } from './parse';
import { runServerTrial, TrialCancelled } from './server';
import { VramProbe } from './vram';

export interface ExecutorDeps {
  settings(): Settings;
  logs: LogBuffer;
  /** GPUs seen by the Monitor (all of them, hidden ones included). */
  gpus(): GpuSample[];
  /** Current read bandwidth of the model's disk (Monitor), null if unknown. */
  disk(): number | null;
  /** Directory and environment variables of the source profile (null if the profile no longer exists). */
  profile?(id: number): Pick<Profile, 'cwd' | 'env'> | null;
  fetch?: typeof fetch;
  now?: () => number;
  killTimeoutMs?: number;
}

export type ExecResult = BenchFinish &
  Required<Pick<BenchFinish, 'status' | 'vramPeak' | 'logExcerpt' | 'durationMs' | 'diskReadPeakBps'>>;

type Child = Spawned<'pipe', 'pipe'>;

interface Exec {
  run: BenchRun;
  spec: BenchSpec;
  live: BenchLive;
  liveAt: number;
  onLive(l: BenchLive): void;
  tail: string[];
  peaks: Map<string, { name: string; bytes: number }>;
  diskPeak: number | null;
  proc: Child | null;
  abort: AbortController;
  cancelled: boolean;
}

const TAIL = 50;
const LIVE_LINES = 20;
const SAMPLE_MS = 500;
const MIB = 1024 * 1024;
const LIVE_THROTTLE_MS = 250;

/**
 * Executes a run (llama-bench or llama-server) already saved as “running” and returns its result without writing it.
 * One at a time. Does not touch the managed server: that is the gate's job (gate.ts).
 */
export class RunExecutor {
  private cur: Exec | null = null;
  private readonly now: () => number;
  private readonly killTimeoutMs: number;

  constructor(private readonly deps: ExecutorDeps) {
    this.now = deps.now ?? Date.now;
    this.killTimeoutMs = deps.killTimeoutMs ?? 5000;
  }

  private source(spec: BenchSpec): Pick<Profile, 'cwd' | 'env'> | null {
    return spec.profileId !== null ? (this.deps.profile?.(spec.profileId) ?? null) : null;
  }

  /**
   * A run's command. Server: model, projector, flags from the fields then other flags, on 127.0.0.1 and the settings'
   * port, in the directory and with the environment of the source profile (its flags may point to relative paths).
   */
  commandOf(spec: BenchSpec): { argv: string[]; display: string; cmd: BuiltCommand | null } {
    if (spec.kind === 'server') {
      const source = this.source(spec);
      const profile: Profile = {
        id: spec.profileId ?? 0,
        name: 'bench',
        model: spec.modelPath,
        ...(spec.mmprojPath ? { mmproj: spec.mmprojPath } : {}),
        cwd: source?.cwd ?? dirname(spec.modelPath),
        host: '127.0.0.1',
        args: [...serverArgs(spec.params), ...spec.serverArgs],
        env: source?.env ?? {},
        source: 'ui',
        createdAt: 0,
        updatedAt: 0,
      };
      const cmd = buildCommand(profile, this.deps.settings());
      return { argv: cmd.argv, display: cmd.display, cmd };
    }
    const bin = benchBinary(binaryPath(this.deps.settings()));
    const argv = [
      'setpriv',
      '--pdeathsig',
      'KILL',
      '--',
      bin,
      '-m',
      spec.modelPath,
      '-o',
      'json',
      '--progress',
      '-r',
      String(spec.r),
      '-p',
      String(spec.p),
      '-n',
      String(spec.n),
      ...benchArgs(spec.params),
    ];
    return { argv, display: shellQuote(argv.slice(4)), cmd: null };
  }

  /** Executes the run; `onLive` receives the loading…measure phases and the last lines (at most every 250 ms). */
  /** `spec`: the requested one (the saved run loses a profileId whose profile no longer exists). */
  async run(
    run: BenchRun,
    o: { onLive(l: BenchLive): void; startedAt?: number; spec?: BenchSpec },
  ): Promise<ExecResult> {
    if (this.cur) throw new Error('a run is already in progress');
    const t0 = this.now();
    const spec = o.spec ?? run.spec;
    const ex: Exec = {
      run,
      spec,
      live: { runId: run.id, kind: run.kind, phase: 'loading', step: null, startedAt: o.startedAt ?? t0, lines: [] },
      liveAt: 0,
      onLive: o.onLive,
      tail: [],
      peaks: new Map(),
      diskPeak: null,
      proc: null,
      abort: new AbortController(),
      cancelled: false,
    };
    this.cur = ex;
    using _cur = defer(() => (this.cur = null));
    let result: BenchFinish;
    try {
      this.setLive(ex, {});
      if (!(await fileExists(spec.modelPath))) throw new Error(`Model not found: ${spec.modelPath}`);
      const { argv, cmd } = this.commandOf(spec);
      result = ex.cancelled
        ? { status: 'cancelled' }
        : cmd
          ? await this.runServer(ex, cmd)
          : await this.runBench(ex, argv);
    } catch (e) {
      result = ex.cancelled ? { status: 'cancelled' } : { status: 'failed', error: (e as Error).message };
    }
    const vramPeak = [...ex.peaks]
      .map(([key, p]) => ({ key, name: p.name, mib: Math.round(p.bytes / MIB) }))
      .filter((p) => p.mib > 0);
    return {
      error: null,
      ...result,
      status: result.status ?? 'failed',
      vramPeak,
      logExcerpt: ex.tail.join('\n'),
      durationMs: this.now() - t0,
      diskReadPeakBps: ex.diskPeak,
    };
  }

  /** Cancels the running run: SIGTERM then SIGKILL; its result becomes “cancelled”. */
  cancel(): boolean {
    const ex = this.cur;
    if (!ex || ex.cancelled) return false;
    ex.cancelled = true;
    ex.abort.abort();
    if (ex.proc) this.kill(ex.proc);
    this.line(ex, 'cancellation requested');
    this.setLive(ex, {});
    return true;
  }

  /** Shutdown: immediate SIGKILL, resolved when the child exits. */
  async killNow(): Promise<void> {
    const ex = this.cur;
    if (!ex) return;
    ex.cancelled = true;
    ex.abort.abort();
    ex.onLive = () => {};
    const proc = ex.proc;
    try {
      proc?.kill('SIGKILL');
    } catch {}
    await proc?.exited;
  }

  private setLive(ex: Exec, patch: Partial<BenchLive>): void {
    ex.live = { ...ex.live, ...patch };
    ex.liveAt = this.now();
    ex.onLive(ex.live);
  }

  /** New lines: broadcast at most every 250 ms (llama-server writes hundreds of them while loading). */
  private touchLive(ex: Exec): void {
    if (this.now() - ex.liveAt >= LIVE_THROTTLE_MS) this.setLive(ex, {});
  }

  private line(ex: Exec, l: string): void {
    this.deps.logs.push(`[bench] ${l}`);
    ex.tail.push(l);
    if (ex.tail.length > TAIL) ex.tail.shift();
    ex.live.lines = ex.tail.slice(-LIVE_LINES);
  }

  /**
   * VRAM peak above what each card held at launch: fast sampling (VramProbe, 100 ms) and, as a fallback, the
   * Monitor's snapshots (1 s by default: a short peak can slip past them). Read peak of the model's disk.
   */
  private sampler(ex: Exec): AsyncDisposable {
    const gpus = this.deps.gpus();
    const before = new Map(gpus.map((g) => [g.key, g.vramUsedBytes]));
    const probe = new VramProbe(gpus);
    const note = (key: string, name: string, bytes: number) => {
      const prev = ex.peaks.get(key);
      if (!prev || bytes > prev.bytes) ex.peaks.set(key, { name, bytes });
    };
    const sample = () => {
      for (const g of this.deps.gpus()) note(g.key, g.name, Math.max(0, g.vramUsedBytes - (before.get(g.key) ?? 0)));
      const d = this.deps.disk();
      if (d !== null && (ex.diskPeak === null || d > ex.diskPeak)) ex.diskPeak = d;
    };
    const timer = setInterval(sample, SAMPLE_MS);
    // `await using`: last sample, probe stop and the fast probe's peaks, when the run exits.
    return {
      [Symbol.asyncDispose]: async () => {
        sample();
        clearInterval(timer);
        await probe.stop();
        for (const g of gpus) {
          const p = probe.get(g.key);
          if (p) note(g.key, g.name, Math.max(0, p.max - p.first));
        }
      },
    };
  }

  private async runBench(ex: Exec, argv: string[]): Promise<BenchFinish> {
    this.deps.logs.push(`[bench] ${ex.run.command}`);
    await using _sampling = this.sampler(ex);
    let proc: Child;
    try {
      // Environment of the settings then of the source profile (CUDA_VISIBLE_DEVICES…: same cards as the server).
      proc = spawnProc(argv, {
        env: { ...process.env, ...this.deps.settings().env, ...this.source(ex.spec)?.env },
      });
    } catch (e) {
      return { status: 'failed', error: (e as Error).message };
    }
    ex.proc = proc;
    if (ex.cancelled) this.kill(proc);
    const stdout = new Response(proc.stdout).text();
    const stderr = this.pipe(proc.stderr, (l) => {
      this.line(ex, l);
      const p = parseBenchProgress(l);
      if (p) {
        const runs = p.runs ?? ex.spec.r;
        this.setLive(ex, {
          phase: p.phase,
          step: { index: (p.test - 1) * runs + (p.run ?? 0), total: p.tests * runs },
        });
      } else this.touchLive(ex);
    });
    await proc.exited;
    const [out] = await Promise.all([stdout.catch(() => ''), stderr]);
    ex.proc = null;
    if (ex.cancelled) return { status: 'cancelled' };
    const parsed = proc.exitCode === 0 ? parseBenchJson(out) : null;
    if (parsed && (parsed.pp || parsed.tg)) return { status: 'ok', pp: parsed.pp, tg: parsed.tg };
    return { status: 'failed', error: benchFailure(ex.tail, proc.exitCode ?? proc.signalCode ?? '?').message };
  }

  private async runServer(ex: Exec, cmd: BuiltCommand): Promise<BenchFinish> {
    this.deps.logs.push(`[bench] ${cmd.display}`);
    await using _sampling = this.sampler(ex);
    using _proc = defer(() => (ex.proc = null));
    try {
      const r = await runServerTrial({
        cmd,
        p: ex.spec.p,
        n: ex.spec.n,
        r: ex.spec.r,
        signal: ex.abort.signal,
        onPhase: (phase, step) => this.setLive(ex, { phase, step: step ?? null }),
        onLine: (l) => {
          this.line(ex, l);
          this.touchLive(ex);
        },
        onSpawn: (proc) => {
          ex.proc = proc;
        },
        fetch: this.deps.fetch,
        now: this.now,
      });
      return { status: 'ok', pp: r.pp, tg: r.tg, draftAcceptPct: r.draftAcceptPct };
    } catch (e) {
      if (e instanceof TrialCancelled || ex.cancelled) return { status: 'cancelled' };
      return { status: 'failed', error: (e as Error).message };
    }
  }

  private async pipe(stream: ReadableStream<Uint8Array>, push: (line: string) => void): Promise<void> {
    const split = new LineSplitter();
    const dec = new TextDecoder();
    try {
      for await (const chunk of stream) for (const l of split.push(dec.decode(chunk, { stream: true }))) push(l);
    } catch {}
    for (const l of split.flush()) push(l);
  }

  private kill(proc: Child): void {
    try {
      proc.kill('SIGTERM');
    } catch {}
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
    }, this.killTimeoutMs);
    void proc.exited.then(() => clearTimeout(timer));
  }
}
