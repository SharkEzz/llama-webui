import { type BenchHardware, type BenchLive, type BenchRun, type BenchSpec, rankRuns, type Sweep, type SweepLive, sweepCtx } from "@llama-webui/shared";
import type { BenchFinish, BenchRunsRepo } from "../db/benchRuns";
import type { SweepsRepo } from "../db/sweeps";
import { HttpError, notFound } from "../http";
import type { RunExecutor } from "./execute";
import type { BenchGate } from "./gate";

export type { ServerControl } from "./gate";

export interface BenchRunnerDeps {
  repo: BenchRunsRepo;
  sweeps: SweepsRepo;
  /** La garde du serveur, dans le runtime (survit aux rechargements). */
  gate: BenchGate;
  executor: RunExecutor;
  hardware(): Promise<BenchHardware>;
  onLive(l: BenchLive | null): void;
  onRun(r: BenchRun): void;
  onSweep(s: Sweep): void;
  onSweepLive(l: SweepLive | null): void;
  now?: () => number;
  /** Pause entre deux éléments d'un sweep, le temps que la VRAM se libère (1 s). */
  pauseMs?: number;
}

interface Current {
  run: BenchRun;
  spec: BenchSpec;
  sweepId: number | null;
  live: BenchLive;
  cancelled: boolean;
  /** Résultat enregistré (il ne reste que la relance du serveur). */
  finished: boolean;
}

const INTERRUPTED = "interrompu (rechargement ou arrêt de llama-webui)";

/**
 * Les benchmarks : runs ponctuels et sweeps, un à la fois. La garde (gate) arrête le serveur géré une fois et le relance
 * une fois ; l'exécuteur lance chaque run. Recréé à chaque rechargement `bun --hot` : dispose() rend la main et le
 * nouveau runner reprend un sweep en cours (resume).
 */
export class BenchRunner {
  private current: Current | null = null;
  private sweep: { id: number; cancelled: boolean } | null = null;
  private sweepLiveV: SweepLive | null = null;
  /** Vrai entre l'acceptation d'un run et son lancement (await du matériel, de la garde). */
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

  private async checkFiles(spec: Pick<BenchSpec, "modelPath" | "mmprojPath">): Promise<void> {
    if (!(await Bun.file(spec.modelPath).exists())) throw new HttpError(400, `Modèle introuvable : ${spec.modelPath}`);
    if (spec.mmprojPath && !(await Bun.file(spec.mmprojPath).exists())) throw new HttpError(400, `Projecteur introuvable : ${spec.mmprojPath}`);
  }

  /** Run ponctuel : créé puis lancé en arrière-plan ; renvoie le run créé (statut « running »). */
  async start(spec: BenchSpec, o: { stopServer: boolean }): Promise<BenchRun> {
    if (this.busy) throw new HttpError(409, "Un benchmark est en cours");
    this.claimed = true;
    try {
      await this.checkFiles(spec);
      await this.deps.gate.acquire(o);
      try {
        const hardware = await this.deps.hardware();
        const run = this.deps.repo.create(spec, this.deps.executor.commandOf(spec).display, hardware);
        this.deps.onRun(run);
        void this.oneOff(run, spec);
        return run;
      } catch (e) {
        await this.deps.gate.release().catch(() => {});
        throw e;
      }
    } finally {
      this.claimed = false;
    }
  }

  private newCurrent(run: BenchRun, sweepId: number | null, spec: BenchSpec = run.spec): Current {
    const phase = this.deps.gate.isStopping ? "stopping-server" : "loading";
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

  /** Exécute le run courant (après l'arrêt du serveur) et enregistre son résultat ; null si le runner a été libéré. */
  private async execute(cur: Current): Promise<BenchRun | null> {
    let result: BenchFinish;
    try {
      await this.deps.gate.ready();
      result = cur.cancelled
        ? { status: "cancelled" }
        : await this.deps.executor.run(cur.run, { onLive: (l) => this.setLive(cur, l), startedAt: cur.live.startedAt, spec: cur.spec });
    } catch (e) {
      result = cur.cancelled ? { status: "cancelled" } : { status: "failed", error: `arrêt de llama-server impossible : ${(e as Error).message}` };
    }
    if (this.disposed) return null;
    const finished = this.deps.repo.finish(cur.run.id, { error: null, ...result });
    cur.finished = true;
    this.deps.onRun(finished);
    return finished;
  }

  /** Relance le serveur ; un échec est noté sur `runId` (carte « Dernier run », historique). */
  private async release(cur: Current | null, runId: number | null): Promise<void> {
    if (cur && this.deps.gate.stoppedCommand) this.setLive(cur, { phase: "restarting-server", step: null });
    try {
      await this.deps.gate.release();
    } catch (e) {
      if (this.disposed || runId === null) return;
      const prev = this.deps.repo.get(runId);
      if (prev) this.deps.onRun(this.deps.repo.finish(runId, { error: prev.error ? `${prev.error} ; ${(e as Error).message}` : (e as Error).message }));
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
   * Lance un sweep : la garde est prise une fois, puis ses éléments en attente s'enchaînent. `target` : l'id d'un sweep
   * existant, ou la fonction qui le crée (appelée seulement une fois la garde prise : un refus 409 n'écrit rien).
   */
  async startSweep(target: number | (() => number), o: { stopServer: boolean }): Promise<Sweep> {
    if (this.busy) throw new HttpError(409, "Un benchmark est en cours");
    this.claimed = true;
    try {
      if (typeof target === "number") {
        const sw = this.deps.sweeps.get(target);
        if (!sw) throw notFound("Sweep");
        await this.checkFiles(sw.spec);
      }
      await this.deps.gate.acquire(o);
      let id: number;
      try {
        id = typeof target === "number" ? target : target();
      } catch (e) {
        await this.deps.gate.release().catch(() => {});
        throw e;
      }
      return this.begin(id);
    } finally {
      this.claimed = false;
    }
  }

  private begin(id: number, after: Promise<void> | null = null): Sweep {
    this.sweep = { id, cancelled: false };
    const sw = this.deps.sweeps.setStatus(id, "running", { finishedAt: null });
    this.deps.onSweep(sw);
    void this.loop(id, after);
    return sw;
  }

  /**
   * Nouveau module (rechargement) : reprend le sweep en cours avec la garde laissée par l'ancien, une fois sorti le process
   * qu'il a tué (sinon l'élément rejoué partage les cartes avec lui : VRAM de départ faussée, OOM possible).
   */
  async resume(): Promise<void> {
    const sw = this.deps.sweeps.running();
    if (!sw || this.claimed || this.current || this.sweep) return;
    const after = this.deps.gate.adopt();
    if (after) this.begin(sw.id, after);
  }

  private async loop(id: number, after: Promise<void> | null = null): Promise<void> {
    const state = this.sweep!;
    if (after) await after;
    let lastRun: number | null = null;
    while (!this.disposed && !state.cancelled) {
      const next = this.deps.repo.nextQueued(id);
      if (!next) break;
      const { counts } = this.deps.sweeps.get(id)!;
      this.setSweepLive({ sweepId: id, runId: next.id, index: counts.total - counts.queued + 1, total: counts.total, stage: next.kind === "server" ? "validate" : "explore" });
      const done = await this.item(next, id);
      if (!done) return;
      lastRun = done.id;
      this.deps.onSweep(this.deps.sweeps.get(id)!);
      if (this.deps.pauseMs !== 0 && this.deps.repo.nextQueued(id)) await Bun.sleep(this.deps.pauseMs ?? 1000);
    }
    if (this.disposed) return;
    const sw = this.deps.sweeps.setStatus(id, state.cancelled ? "cancelled" : "done", { bestRunId: this.best(id), finishedAt: this.now() });
    this.deps.onSweep(sw);
    if (this.current) this.setLive(this.current, {});
    await this.release(null, lastRun);
    if (this.disposed) return;
    this.sweep = null;
    this.setSweepLive(null);
  }

  /** Un élément : figé (commande, matériel), exécuté, enregistré. Un échec (OOM compris) n'arrête pas le sweep. */
  private async item(queued: BenchRun, sweepId: number): Promise<BenchRun | null> {
    let hardware: BenchHardware;
    try {
      hardware = await this.deps.hardware();
    } catch {
      hardware = { cpu: "", gpus: [], build: null };
    }
    if (this.disposed) return null;
    const run = this.deps.repo.begin(queued.id, { command: this.deps.executor.commandOf(queued.spec).display, hardware });
    this.deps.onRun(run);
    const cur = this.newCurrent(run, sweepId);
    const done = await this.execute(cur);
    if (!done) return null;
    this.current = null;
    this.deps.onLive(null);
    return done;
  }

  /** Le meilleur run du sweep : parmi les validations serveur s'il y en a de réussies, sinon parmi l'exploration. */
  private best(id: number): number | null {
    const sw = this.deps.sweeps.get(id);
    if (!sw) return null;
    const runs = this.deps.repo.list({ sweepId: id });
    const validated = runs.some((r) => r.kind === "server" && r.status === "ok");
    const top = rankRuns(runs.filter((r) => r.kind === (validated ? "server" : "bench")), sw.spec.preset, sweepCtx(sw.spec))[0];
    return top?.rank ? top.run.id : null;
  }

  /** Annule le run en cours (s'il porte cet id) ; dans un sweep, on passe à l'élément suivant. */
  cancel(id: number): boolean {
    const cur = this.current;
    if (!cur || cur.run.id !== id || cur.cancelled || cur.finished) return false;
    cur.cancelled = true;
    this.deps.executor.cancel();
    this.setLive(cur, {});
    return true;
  }

  /** Annule le sweep : sa file passe « cancelled », le run en cours est arrêté, le serveur relancé. */
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
   * Rechargement (`restart: true`) ou arrêt de Bun. L'enfant est tué. Un run ponctuel est « interrupted » ; un élément de
   * sweep repasse en attente au rechargement (le nouveau runner le rejoue) et le sweep reste « running ». La garde est
   * rendue plus tard : le nouveau module la reprend, sinon elle relance le serveur.
   */
  dispose(o: { restart: boolean }): void {
    if (this.disposed) return;
    this.disposed = true;
    const cur = this.current;
    const sweep = this.sweep;
    this.current = null;
    this.sweep = null;
    const killed = this.deps.executor.killNow();
    const { repo } = this.deps;
    try {
      if (cur && !cur.finished) {
        if (cur.sweepId !== null && o.restart) repo.requeue(cur.run.id);
        else repo.finish(cur.run.id, { status: "interrupted", error: INTERRUPTED, durationMs: this.now() - cur.live.startedAt });
      }
      if (sweep && !o.restart) this.deps.sweeps.setStatus(sweep.id, "interrupted");
    } catch {}
    if (o.restart) this.deps.gate.releaseLater(killed);
  }
}
