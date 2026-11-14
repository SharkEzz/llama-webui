import { setTimeout as sleep } from 'node:timers/promises';
import {
  type BenchHardware,
  type BenchLive,
  type BenchRun,
  type BenchSpec,
  defer,
  rankRuns,
  type Sweep,
  type SweepLive,
  sweepCtx,
} from '@llama-webui/shared';
import type { BenchFinish, BenchRunsRepo } from '../db/benchRuns';
import type { SweepsRepo } from '../db/sweeps';
import { HttpError, notFound } from '../http';
import { fileExists } from '../proc';
import type { BuiltCommand } from '../supervisor/args';
import type { RunExecutor } from './execute';
import type { BenchGate } from './gate';

export type { ServerControl } from './gate';

export interface BenchRunnerDeps {
  repo: BenchRunsRepo;
  sweeps: SweepsRepo;
  /** The server gate, in the runtime. */
  gate: BenchGate;
  executor: RunExecutor;
  hardware(): Promise<BenchHardware>;
  onLive(l: BenchLive | null): void;
  onRun(r: BenchRun): void;
  onSweep(s: Sweep): void;
  onSweepLive(l: SweepLive | null): void;
  now?: () => number;
  /** Pause between two sweep items, while the VRAM is freed (1 s). */
  pauseMs?: number;
  /** The command of the stopped server's profile as it is now, to restart it with the edits saved meanwhile (#39). */
  rebuild?: (stopped: BuiltCommand) => BuiltCommand | null;
}

interface Current {
  run: BenchRun;
  spec: BenchSpec;
  sweepId: number | null;
  live: BenchLive;
  cancelled: boolean;
  /** Result saved (only the server restart is left). */
  finished: boolean;
}

const INTERRUPTED = 'interrupted (llama-webui stopped)';

/**
 * The benchmarks: one-off runs and sweeps, one at a time. The gate stops the managed server once and restarts it
 * once; the executor runs each run.
 */
export class BenchRunner {
  private current: Current | null = null;
  private sweep: { id: number; cancelled: boolean } | null = null;
  private sweepLiveV: SweepLive | null = null;
  /** True between accepting a run and starting it (awaiting the hardware, the gate). */
  private claimed = false;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly deps: BenchRunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  get busy(): boolean {
    return this.claimed || this.current !== null || this.sweep !== null || this.deps.gate.held;
  }

  get live(): BenchLive | null {
    return this.current?.live ?? null;
  }

  get sweepLive(): SweepLive | null {
    return this.sweepLiveV;
  }

  private setLive(cur: Current, patch: Partial<BenchLive>): void {
    if (this.disposed || this.current !== cur) return;
    cur.live = { ...cur.live, ...patch };
    this.deps.onLive(cur.live);
  }

  private setSweepLive(l: SweepLive | null): void {
    if (this.disposed) return;
    this.sweepLiveV = l;
    this.deps.onSweepLive(l);
  }

  private async checkFiles(spec: Pick<BenchSpec, 'modelPath' | 'mmprojPath'>): Promise<void> {
    if (!(await fileExists(spec.modelPath))) throw new HttpError(400, `Model not found: ${spec.modelPath}`);
    if (spec.mmprojPath && !(await fileExists(spec.mmprojPath)))
      throw new HttpError(400, `Projector not found: ${spec.mmprojPath}`);
  }

  /** One-off run: created then started in the background; returns the created run (status “running”). */
  async start(spec: BenchSpec, o: { stopServer: boolean }): Promise<BenchRun> {
    if (this.busy) throw new HttpError(409, 'A benchmark is running');
    this.claimed = true;
    using _claim = defer(() => (this.claimed = false));
    await this.checkFiles(spec);
    await this.deps.gate.acquire(o);
    try {
      const hardware = await this.deps.hardware();
      const run = this.deps.repo.create(spec, this.deps.executor.commandOf(spec).display, hardware);
      this.deps.onRun(run);
      void this.oneOff(run, spec);
      return run;
    } catch (e) {
      await this.deps.gate.release(this.deps.rebuild).catch(() => {});
      throw e;
    }
  }

  private newCurrent(run: BenchRun, sweepId: number | null, spec: BenchSpec = run.spec): Current {
    const phase = this.deps.gate.isStopping ? 'stopping-server' : 'loading';
    const cur: Current = {
      run,
      spec,
      sweepId,
      live: { runId: run.id, kind: run.kind, phase, step: null, startedAt: this.now(), lines: [] },
      cancelled: false,
      finished: false,
    };
    this.current = cur;
    this.deps.onLive(cur.live);
    return cur;
  }

  /** Executes the current run (after the server stop) and saves its result; null if the runner was disposed. */
  private async execute(cur: Current): Promise<BenchRun | null> {
    let result: BenchFinish;
    try {
      await this.deps.gate.ready();
      result = cur.cancelled
        ? { status: 'cancelled' }
        : await this.deps.executor.run(cur.run, {
            onLive: (l) => this.setLive(cur, l),
            startedAt: cur.live.startedAt,
            spec: cur.spec,
          });
    } catch (e) {
      result = cur.cancelled
        ? { status: 'cancelled' }
        : { status: 'failed', error: `could not stop llama-server: ${(e as Error).message}` };
    }
    if (this.disposed) return null;
    const finished = this.deps.repo.finish(cur.run.id, { error: null, ...result });
    cur.finished = true;
    this.deps.onRun(finished);
    return finished;
  }

  /** Restarts the server; a failure is recorded on `runId` (“Last run” card, history). */
  private async release(cur: Current | null, runId: number | null): Promise<void> {
    if (cur && this.deps.gate.stoppedCommand) this.setLive(cur, { phase: 'restarting-server', step: null });
    try {
      await this.deps.gate.release(this.deps.rebuild);
    } catch (e) {
      if (this.disposed || runId === null) return;
      const prev = this.deps.repo.get(runId);
      if (prev)
        this.deps.onRun(
          this.deps.repo.finish(runId, {
            error: prev.error ? `${prev.error}; ${(e as Error).message}` : (e as Error).message,
          }),
        );
    }
  }

  private async oneOff(run: BenchRun, spec: BenchSpec): Promise<void> {
    const cur = this.newCurrent(run, null, spec);
    if (!(await this.execute(cur))) return;
    await this.release(cur, run.id);
    if (this.disposed) return;
    this.current = null;
    this.deps.onLive(null);
  }

  /**
   * Starts a sweep: the gate is taken once, then its queued items run one after another. `target`: the id of an existing
   * sweep, or the function that creates or requeues it (called only once the gate is taken: a 409 refusal writes
   * nothing). The model files are checked first, from the sweep for an id, from `o.files` otherwise (resume, validate):
   * a deleted model is one 400, not every item failing with "Model not found".
   */
  async startSweep(
    target: number | (() => number),
    o: { stopServer: boolean; files?: Pick<BenchSpec, 'modelPath' | 'mmprojPath'> },
  ): Promise<Sweep> {
    if (this.busy) throw new HttpError(409, 'A benchmark is running');
    this.claimed = true;
    using _claim = defer(() => (this.claimed = false));
    if (typeof target === 'number') {
      const sw = this.deps.sweeps.get(target);
      if (!sw) throw notFound('Sweep');
      await this.checkFiles(sw.spec);
    } else if (o.files) await this.checkFiles(o.files);
    await this.deps.gate.acquire(o);
    let id: number;
    try {
      id = typeof target === 'number' ? target : target();
    } catch (e) {
      await this.deps.gate.release(this.deps.rebuild).catch(() => {});
      throw e;
    }
    return this.begin(id);
  }

  private begin(id: number): Sweep {
    this.sweep = { id, cancelled: false };
    const sw = this.deps.sweeps.setStatus(id, 'running', { finishedAt: null });
    this.deps.onSweep(sw);
    void this.loop(id);
    return sw;
  }

  private async loop(id: number): Promise<void> {
    const state = this.sweep!;
    let lastRun: number | null = null;
    while (!this.disposed && !state.cancelled) {
      const next = this.deps.repo.nextQueued(id);
      if (!next) break;
      const { counts } = this.deps.sweeps.get(id)!;
      this.setSweepLive({
        sweepId: id,
        runId: next.id,
        index: counts.total - counts.queued + 1,
        total: counts.total,
        stage: next.kind === 'server' ? 'validate' : 'explore',
      });
      const done = await this.item(next, id);
      if (!done) return;
      lastRun = done.id;
      this.deps.onSweep(this.deps.sweeps.get(id)!);
      if (this.deps.pauseMs !== 0 && this.deps.repo.nextQueued(id)) await sleep(this.deps.pauseMs ?? 1000);
    }
    if (this.disposed) return;
    const sw = this.deps.sweeps.setStatus(id, state.cancelled ? 'cancelled' : 'done', {
      bestRunId: this.best(id),
      finishedAt: this.now(),
    });
    this.deps.onSweep(sw);
    if (this.current) this.setLive(this.current, {});
    await this.release(null, lastRun);
    if (this.disposed) return;
    this.sweep = null;
    this.setSweepLive(null);
  }

  /** One item: frozen (command, hardware), executed, saved. A failure (OOM included) does not stop the sweep. */
  private async item(queued: BenchRun, sweepId: number): Promise<BenchRun | null> {
    let hardware: BenchHardware;
    try {
      hardware = await this.deps.hardware();
    } catch {
      hardware = { cpu: '', gpus: [], build: null };
    }
    if (this.disposed) return null;
    const run = this.deps.repo.begin(queued.id, {
      command: this.deps.executor.commandOf(queued.spec).display,
      hardware,
    });
    this.deps.onRun(run);
    const cur = this.newCurrent(run, sweepId);
    const done = await this.execute(cur);
    if (!done) return null;
    this.current = null;
    this.deps.onLive(null);
    return done;
  }

  /** The sweep's best run: among the server validations if some succeeded, otherwise among the exploration. */
  private best(id: number): number | null {
    const sw = this.deps.sweeps.get(id);
    if (!sw) return null;
    const runs = this.deps.repo.list({ sweepId: id });
    const validated = runs.some((r) => r.kind === 'server' && r.status === 'ok');
    const top = rankRuns(
      runs.filter((r) => r.kind === (validated ? 'server' : 'bench')),
      sw.spec.preset,
      sweepCtx(sw.spec),
    )[0];
    return top?.rank ? top.run.id : null;
  }

  /** Cancels the running run (if it has this id); in a sweep, moves on to the next item. */
  cancel(id: number): boolean {
    const cur = this.current;
    if (!cur || cur.run.id !== id || cur.cancelled || cur.finished) return false;
    cur.cancelled = true;
    this.deps.executor.cancel();
    this.setLive(cur, {});
    return true;
  }

  /** Cancels the sweep: its queue becomes “cancelled”, the running run is stopped, the server restarted. */
  cancelSweep(id: number): boolean {
    const state = this.sweep;
    if (!state || state.id !== id || state.cancelled) return false;
    state.cancelled = true;
    this.deps.repo.cancelQueued(id);
    const cur = this.current;
    if (cur && !cur.finished) {
      cur.cancelled = true;
      this.deps.executor.cancel();
    }
    this.deps.onSweep(this.deps.sweeps.get(id)!);
    return true;
  }

  /**
   * Shutdown: the child is killed, the current run (a sweep item too) is saved as “interrupted”, and so is its sweep
   * (Resume button). The gate is not released: llama-webui is stopping, and llama-server with it.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const cur = this.current;
    const sweep = this.sweep;
    this.current = null;
    this.sweep = null;
    void this.deps.executor.killNow();
    const { repo } = this.deps;
    try {
      if (cur && !cur.finished)
        repo.finish(cur.run.id, {
          status: 'interrupted',
          error: INTERRUPTED,
          durationMs: this.now() - cur.live.startedAt,
        });
      if (sweep) this.deps.sweeps.setStatus(sweep.id, 'interrupted');
    } catch {}
  }
}
