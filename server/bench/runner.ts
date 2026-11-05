import {
  type BenchHardware,
  type BenchLive,
  type BenchPhase,
  type BenchRun,
  type BenchSpec,
  benchArgs,
  type GpuSample,
  type ServerState,
  type Settings,
  shellQuote,
} from "@llama-webui/shared";
import type { BenchFinish, BenchRunsRepo } from "../db/benchRuns";
import { HttpError } from "../http";
import type { LogBuffer } from "../logs/buffer";
import { LineSplitter } from "../logs/lines";
import type { BuiltCommand } from "../supervisor/args";
import { benchBinary, benchFailure, parseBenchJson, parseBenchProgress } from "./parse";
import { VramProbe } from "./vram";

/** Ce que le runner attend du superviseur : arrêter le serveur géré avant un run, le relancer après. */
export interface ServerControl {
  readonly state: ServerState;
  readonly lastCommand: BuiltCommand | null;
  stop(): Promise<void>;
  start(cmd: BuiltCommand): Promise<void>;
}

export interface BenchRunnerDeps {
  repo: BenchRunsRepo;
  settings(): Settings;
  server: ServerControl;
  logs: LogBuffer;
  /** GPU vues par le Monitor (toutes, masquées comprises). */
  gpus(): GpuSample[];
  hardware(): Promise<BenchHardware>;
  onLive(l: BenchLive | null): void;
  onRun(r: BenchRun): void;
  fetch?: typeof fetch;
  now?: () => number;
  killTimeoutMs?: number;
}

type Child = ReturnType<typeof Bun.spawn>;

interface Job {
  run: BenchRun;
  spec: BenchSpec;
  argv: string[];
  /** Commande du serveur géré arrêté pour ce run, à relancer à la fin. */
  stopped: BuiltCommand | null;
  live: BenchLive;
  tail: string[];
  peaks: Map<string, { name: string; bytes: number }>;
  proc: Child | null;
  abort: AbortController;
  cancelled: boolean;
  /** Rechargement ou arrêt de Bun : le run est déjà enregistré « interrupted », plus rien ne doit écrire. */
  disposed: boolean;
  /** Résultat enregistré (il ne reste que la relance du serveur). */
  finished: boolean;
}

const TAIL = 50;
const LIVE_LINES = 20;
const VRAM_SAMPLE_MS = 500;
const MIB = 1024 * 1024;

/**
 * Un benchmark à la fois, hors superviseur. Arrête le serveur géré (après confirmation du client), exécute le run,
 * enregistre le résultat, puis relance le serveur avec la même commande quelle que soit l'issue.
 * Pas dans le runtime : un rechargement `bun --hot` l'arrête (dispose).
 */
export class BenchRunner {
  private job: Job | null = null;
  /** Vrai entre l'acceptation d'un run et la création de son job (await du matériel). */
  private claimed = false;
  private readonly now: () => number;
  private readonly killTimeoutMs: number;

  constructor(private readonly deps: BenchRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.killTimeoutMs = deps.killTimeoutMs ?? 5000;
  }

  get busy(): boolean {
    return this.claimed || this.job !== null;
  }

  get live(): BenchLive | null {
    return this.job?.live ?? null;
  }

  /** Crée le run et le lance en arrière-plan ; renvoie le run créé (statut « running »). */
  async start(spec: BenchSpec, o: { stopServer: boolean }): Promise<BenchRun> {
    if (this.busy) throw new HttpError(409, "Un benchmark est en cours");
    const s = this.deps.server.state;
    if (s.kind === "external") throw new HttpError(409, `Un llama-server externe tourne sur le port ${s.port} : arrêtez-le d'abord`);
    let stopped: BuiltCommand | null = null;
    if (s.kind === "starting" || s.kind === "ready") {
      if (!o.stopServer)
        throw new HttpError(409, `llama-server tourne (profil ${s.profile}) : il sera arrêté pendant le benchmark puis relancé`, "server-running");
      stopped = this.deps.server.lastCommand;
    }
    if (spec.kind === "server") throw new HttpError(501, "run serveur : Task 3");
    this.claimed = true;
    try {
      const argv = this.benchArgv(spec);
      const hardware = await this.deps.hardware();
      const run = this.deps.repo.create(spec, shellQuote(argv.slice(4)), hardware);
      const job: Job = {
        run,
        spec,
        argv,
        stopped,
        live: { runId: run.id, kind: spec.kind, phase: stopped ? "stopping-server" : "loading", step: null, startedAt: this.now(), lines: [] },
        tail: [],
        peaks: new Map(),
        proc: null,
        abort: new AbortController(),
        cancelled: false,
        disposed: false,
        finished: false,
      };
      this.job = job;
      this.deps.onRun(run);
      this.deps.onLive(job.live);
      void this.execute(job);
      return run;
    } finally {
      this.claimed = false;
    }
  }

  private benchArgv(spec: BenchSpec): string[] {
    const bin = benchBinary(this.deps.settings().binary);
    return [
      "setpriv",
      "--pdeathsig",
      "KILL",
      "--",
      bin,
      "-m",
      spec.modelPath,
      "-o",
      "json",
      "--progress",
      "-r",
      String(spec.r),
      "-p",
      String(spec.p),
      "-n",
      String(spec.n),
      ...benchArgs(spec.params),
    ];
  }

  private setLive(job: Job, patch: Partial<BenchLive>): void {
    if (job.disposed) return;
    job.live = { ...job.live, ...patch };
    this.deps.onLive(job.live);
  }

  private line(job: Job, l: string): void {
    this.deps.logs.push(`[bench] ${l}`);
    job.tail.push(l);
    if (job.tail.length > TAIL) job.tail.shift();
    job.live.lines = job.tail.slice(-LIVE_LINES);
  }

  private async execute(job: Job): Promise<void> {
    const t0 = this.now();
    let result: BenchFinish;
    try {
      if (job.stopped) {
        this.line(job, "arrêt de llama-server pendant le benchmark");
        await this.deps.server.stop();
      }
      result = job.cancelled ? { status: "cancelled" } : await this.runBench(job);
    } catch (e) {
      result = job.cancelled ? { status: "cancelled" } : { status: "failed", error: (e as Error).message };
    }
    if (job.disposed) return;
    const vramPeak = [...job.peaks].map(([key, p]) => ({ key, name: p.name, mib: Math.round(p.bytes / MIB) })).filter((p) => p.mib > 0);
    const finished = this.deps.repo.finish(job.run.id, {
      error: null,
      ...result,
      vramPeak,
      logExcerpt: job.tail.join("\n"),
      durationMs: this.now() - t0,
    });
    job.finished = true;
    this.deps.onRun(finished);
    if (job.stopped) {
      this.setLive(job, { phase: "restarting-server", step: null });
      await this.restart(job, job.stopped);
    }
    if (job.disposed) return;
    this.job = null;
    this.deps.onLive(null);
  }

  private async restart(job: Job, cmd: BuiltCommand): Promise<void> {
    this.deps.logs.push(`[bench] relance de llama-server (${cmd.profileName})`);
    try {
      await this.deps.server.start(cmd);
    } catch (e) {
      const msg = `relance de llama-server impossible : ${(e as Error).message}`;
      this.line(job, msg);
      this.setLive(job, {});
    }
  }

  /**
   * Pic de VRAM au-dessus de ce que chaque carte tenait au lancement : relevé rapide (VramProbe, 100 ms) et, en secours,
   * les snapshots du Monitor (1 s par défaut : un pic court peut leur échapper).
   */
  private sampler(job: Job): () => Promise<void> {
    const gpus = this.deps.gpus();
    const before = new Map(gpus.map((g) => [g.key, g.vramUsedBytes]));
    const probe = new VramProbe(gpus);
    const note = (key: string, name: string, bytes: number) => {
      const prev = job.peaks.get(key);
      if (!prev || bytes > prev.bytes) job.peaks.set(key, { name, bytes });
    };
    const sample = () => {
      for (const g of this.deps.gpus()) note(g.key, g.name, Math.max(0, g.vramUsedBytes - (before.get(g.key) ?? 0)));
    };
    const timer = setInterval(sample, VRAM_SAMPLE_MS);
    return async () => {
      sample();
      clearInterval(timer);
      await probe.stop();
      for (const g of gpus) {
        const p = probe.get(g.key);
        if (p) note(g.key, g.name, Math.max(0, p.max - p.first));
      }
    };
  }

  private async runBench(job: Job): Promise<BenchFinish> {
    this.setLive(job, { phase: "loading", step: null });
    this.deps.logs.push(`[bench] ${job.run.command}`);
    const stopSampling = this.sampler(job);
    let proc: Child;
    try {
      proc = Bun.spawn(job.argv, { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      await stopSampling();
      return { status: "failed", error: (e as Error).message };
    }
    job.proc = proc;
    if (job.cancelled) this.kill(proc);
    const stdout = new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const stderr = this.pipe(proc.stderr as ReadableStream<Uint8Array>, (l) => {
      this.line(job, l);
      const p = parseBenchProgress(l);
      if (p) {
        const runs = p.runs ?? job.spec.r;
        const step = { index: (p.test - 1) * runs + (p.run ?? 0), total: p.tests * runs };
        this.setLive(job, { phase: p.phase, step });
      } else this.setLive(job, {});
    });
    await proc.exited;
    const [out] = await Promise.all([stdout.catch(() => ""), stderr]);
    await stopSampling();
    job.proc = null;
    if (job.cancelled) return { status: "cancelled" };
    const parsed = proc.exitCode === 0 ? parseBenchJson(out) : null;
    if (parsed && (parsed.pp || parsed.tg)) return { status: "ok", pp: parsed.pp, tg: parsed.tg };
    return { status: "failed", error: benchFailure(job.tail, proc.exitCode ?? proc.signalCode ?? "?").message };
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
      proc.kill("SIGTERM");
    } catch {}
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, this.killTimeoutMs);
    void proc.exited.then(() => clearTimeout(timer));
  }

  /** Annule le run en cours (s'il porte cet id) ; le serveur arrêté est relancé comme après un run normal. */
  cancel(id: number): boolean {
    const job = this.job;
    if (!job || job.run.id !== id || job.cancelled) return false;
    job.cancelled = true;
    job.abort.abort();
    if (job.proc) this.kill(job.proc);
    this.line(job, "annulation demandée");
    this.setLive(job, {});
    return true;
  }

  /**
   * Rechargement (`restart: true`) ou arrêt de Bun : l'enfant est tué, le run marqué « interrupted ».
   * Au rechargement, le serveur arrêté pour ce run est relancé une fois l'enfant sorti.
   */
  dispose(o: { restart: boolean }): void {
    const job = this.job;
    if (!job) return;
    job.disposed = true;
    this.job = null;
    // Run déjà enregistré : seule la relance du serveur était en cours, elle continue dans le superviseur.
    if (job.finished) return;
    job.cancelled = true;
    job.abort.abort();
    const proc = job.proc;
    try {
      proc?.kill("SIGKILL");
    } catch {}
    try {
      this.deps.repo.finish(job.run.id, {
        status: "interrupted",
        error: "interrompu (rechargement ou arrêt de llama-webui)",
        logExcerpt: job.tail.join("\n"),
        durationMs: this.now() - job.live.startedAt,
      });
    } catch {}
    const cmd = job.stopped;
    if (o.restart && cmd) {
      const server = this.deps.server;
      const logs = this.deps.logs;
      void (proc?.exited ?? Promise.resolve())
        .then(() => server.start(cmd))
        .catch((e) => logs.push(`[bench] relance de llama-server impossible : ${(e as Error).message}`));
    }
  }
}
