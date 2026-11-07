import { existsSync } from "node:fs";
import type { ServerState } from "@llama-webui/shared";
import type { LogBuffer } from "../logs/buffer";
import { LineSplitter } from "../logs/lines";
import type { BuiltCommand } from "./args";
import { findLlamaServerPid } from "./discovery";
import { probeHealth } from "./health";

export type { ServerState };

export class SupervisorError extends Error {
  override name = "SupervisorError";
}

export interface SupervisorOptions {
  logs: LogBuffer;
  killTimeoutMs?: number;
  healthPollMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type Child = ReturnType<typeof Bun.spawn>;

export class Supervisor {
  private _state: ServerState = { kind: "idle" };
  private listeners = new Set<(s: ServerState) => void>();
  private proc: Child | null = null;
  private lastCmd: BuiltCommand | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private logs: LogBuffer;
  private killTimeoutMs: number;
  private healthPollMs: number;
  private fetchImpl: typeof fetch;
  private now: () => number;

  constructor(opts: SupervisorOptions) {
    this.logs = opts.logs;
    this.killTimeoutMs = opts.killTimeoutMs ?? 5000;
    this.healthPollMs = opts.healthPollMs ?? 500;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get state(): ServerState {
    return this._state;
  }

  get managedPid(): number | null {
    return this.proc && this.proc.exitCode === null && this.proc.signalCode === null ? this.proc.pid : null;
  }

  get lastCommand(): BuiltCommand | null {
    return this.lastCmd;
  }

  subscribe(fn: (s: ServerState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(s: ServerState) {
    this._state = s;
    for (const fn of this.listeners) fn(s);
  }

  private async portAnswers(port: number): Promise<boolean> {
    return (await probeHealth(port, this.fetchImpl)) !== null;
  }

  async detectExternal(port: number): Promise<boolean> {
    if (this.proc) return false;
    if (!(await this.portAnswers(port))) return false;
    this.set({ kind: "external", pid: await findLlamaServerPid(port), port });
    return true;
  }

  /** Leaves the external state once that server is gone (PID dead or unknown, and port silent). */
  async recheckExternal(): Promise<void> {
    const s = this._state;
    if (s.kind !== "external") return;
    if (s.pid !== null) {
      try {
        process.kill(s.pid, 0);
        return; // alive but not answering: hung, keep monitoring it
      } catch {}
    }
    if (!(await this.portAnswers(s.port)) && this._state === s) this.set({ kind: "idle" });
  }

  private async externalError(port: number): Promise<SupervisorError> {
    const pid = this._state.kind === "external" ? this._state.pid : await findLlamaServerPid(port);
    return new SupervisorError(`port occupé par un serveur externe (PID ${pid ?? "inconnu"})`);
  }

  // One lifecycle operation at a time: start/restart/switch overlap would spawn two servers.
  private op: Promise<void> | null = null;

  private exclusive(fn: () => Promise<void>): Promise<void> {
    if (this.op) return Promise.reject(new SupervisorError("opération en cours, réessayez"));
    const p = fn().finally(() => {
      if (this.op === p) this.op = null;
    });
    this.op = p;
    return p;
  }

  start(cmd: BuiltCommand): Promise<void> {
    return this.exclusive(() => this.doStart(cmd));
  }

  private async doStart(cmd: BuiltCommand): Promise<void> {
    if (this._state.kind === "external") {
      // The external server may have been stopped since we detected it.
      if (await this.portAnswers(this._state.port)) throw await this.externalError(this._state.port);
      this.set({ kind: "idle" });
    }
    if (this.proc) throw new SupervisorError("un serveur est déjà lancé");
    if (await this.portAnswers(cmd.port)) {
      this.set({ kind: "external", pid: await findLlamaServerPid(cmd.port), port: cmd.port });
      throw await this.externalError(cmd.port);
    }
    this.lastCmd = cmd;
    const fail = (message: string) => {
      this.logs.push(`[llama-webui] échec du lancement: ${message}`);
      this.set({
        kind: "crashed",
        profile: cmd.profileName,
        profileId: cmd.profileId,
        exitCode: null,
        signal: null,
        at: this.now(),
        message,
      });
    };
    if (!existsSync(cmd.cwd)) return fail(`répertoire introuvable: ${cmd.cwd}`);
    let proc: Child;
    try {
      proc = Bun.spawn(cmd.argv, { cwd: cmd.cwd, env: cmd.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      return fail((e as Error).message);
    }
    this.proc = proc;
    this.logs.push(`[llama-webui] lancement: ${cmd.display}`);
    this.pipe(proc.stdout as ReadableStream<Uint8Array>);
    this.pipe(proc.stderr as ReadableStream<Uint8Array>);
    this.set({
      kind: "starting",
      profile: cmd.profileName,
      profileId: cmd.profileId,
      pid: proc.pid,
      port: cmd.port,
      since: this.now(),
    });
    void proc.exited.then(() => this.onExit(proc, cmd));
    this.healthTimer = setInterval(() => void this.pollHealth(proc, cmd), this.healthPollMs);
  }

  private async pipe(stream: ReadableStream<Uint8Array>) {
    const split = new LineSplitter();
    const dec = new TextDecoder();
    try {
      for await (const chunk of stream)
        for (const l of split.push(dec.decode(chunk, { stream: true }))) this.logs.push(l);
    } catch {}
    for (const l of split.flush()) this.logs.push(l);
  }

  private async pollHealth(proc: Child, cmd: BuiltCommand) {
    if (this.proc !== proc || this._state.kind !== "starting") return this.clearHealth();
    const status = await probeHealth(cmd.port, this.fetchImpl);
    if (status === 200 && this.proc === proc && this._state.kind === "starting") {
      this.clearHealth();
      this.set({
        kind: "ready",
        profile: cmd.profileName,
        profileId: cmd.profileId,
        pid: proc.pid,
        port: cmd.port,
        since: this.now(),
      });
    }
  }

  private clearHealth() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private onExit(proc: Child, cmd: BuiltCommand) {
    if (this.proc !== proc) return;
    this.clearHealth();
    this.proc = null;
    const wasStopping = this._state.kind === "stopping";
    this.logs.push(
      `[llama-webui] llama-server terminé (code ${proc.exitCode ?? "-"}${proc.signalCode ? `, ${proc.signalCode}` : ""})`,
    );
    if (wasStopping) this.set({ kind: "idle" });
    else
      this.set({
        kind: "crashed",
        profile: cmd.profileName,
        profileId: cmd.profileId,
        exitCode: proc.exitCode,
        signal: proc.signalCode == null ? null : String(proc.signalCode),
        at: this.now(),
      });
  }

  /** Stops the managed server (never touches an external one). Waits for any operation in progress. */
  async stop(): Promise<void> {
    while (this.op) await this.op.catch(() => {});
    const p = this.doStop().finally(() => {
      if (this.op === p) this.op = null;
    });
    this.op = p;
    return p;
  }

  private async doStop(): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      if (this._state.kind === "crashed") this.set({ kind: "idle" });
      return;
    }
    const s = this._state;
    if (s.kind === "starting" || s.kind === "ready")
      this.set({ kind: "stopping", profile: s.profile, profileId: s.profileId, pid: s.pid, port: s.port });
    this.clearHealth();
    try {
      proc.kill("SIGTERM");
    } catch {}
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(this.killTimeoutMs).then(() => false)]);
    if (!exited) {
      this.logs.push(`[llama-webui] pas d'arrêt après ${this.killTimeoutMs} ms, SIGKILL`);
      try {
        proc.kill("SIGKILL");
      } catch {}
      await proc.exited;
    }
    // onExit runs from the exited promise; make sure it ran before returning.
    await Promise.resolve();
    if (this.proc === proc) this.onExit(proc, this.lastCmd!);
  }

  switchTo(cmd: BuiltCommand): Promise<void> {
    return this.exclusive(async () => {
      await this.doStop();
      await this.doStart(cmd);
    });
  }

  /** Synchronous last-resort kill, for process 'exit' handlers. */
  killNow(): void {
    this.clearHealth();
    try {
      this.proc?.kill("SIGKILL");
    } catch {}
  }
}
