import { setTimeout as sleep } from 'node:timers/promises';
import { defer, type ServerState } from '@llama-webui/shared';
import { HttpError } from '../http';
import type { LogBuffer } from '../logs/buffer';
import type { BuiltCommand } from '../supervisor/args';

/** What the gate expects from the supervisor: stop the managed server before a benchmark, restart it afterwards. */
export interface ServerControl {
  readonly state: ServerState;
  readonly lastCommand: BuiltCommand | null;
  stop(): Promise<void>;
  start(cmd: BuiltCommand): Promise<void>;
}

export interface GateDeps {
  server: ServerControl;
  logs: LogBuffer;
  /** Time left to the new module to take over the gate after a reload (3 s). */
  adoptGraceMs?: number;
  /** Maximum wait for a stop already in progress before taking the gate (60 s). */
  stoppingTimeoutMs?: number;
}

const POLL_MS = 100;

/**
 * The server gate during benchmarks: a single holder (one-off run or sweep), the managed server stopped once on
 * acquire and restarted once on release, the external server detector paused while it is held.
 * Lives in the runtime (survives `bun --hot`): the runner is recreated on every reload, the gate is not, so a
 * sweep resumes in the new module without restarting the server in between. Changing this file requires restarting Bun.
 */
export class BenchGate {
  private holding = false;
  /** Command of the server actually stopped by the gate, to restart. */
  private stopped: BuiltCommand | null = null;
  private stopping: Promise<void> | null = null;
  private releasing: Promise<void> | null = null;
  private pending: { cancelled: boolean; settled: Promise<void> } | null = null;

  constructor(private readonly deps: GateDeps) {}

  get held(): boolean {
    return this.holding;
  }

  get stoppedCommand(): BuiltCommand | null {
    return this.stopped;
  }

  /** True while the server stop started by acquire() is not finished. */
  get isStopping(): boolean {
    return this.stopping !== null;
  }

  /**
   * Takes the gate. Refused (409) if it is already held, if an external server is running, or if the managed server is
   * running without `stopServer` (code “server-running”, the client asks for confirmation). A stop already in progress is
   * awaited (nothing to restart afterwards). Otherwise the server stop is started without being awaited: `ready()` does that.
   */
  async acquire(o: { stopServer: boolean }): Promise<void> {
    if (this.holding) throw new HttpError(409, 'A benchmark is running');
    this.holding = true;
    try {
      const { server } = this.deps;
      const deadline = Date.now() + (this.deps.stoppingTimeoutMs ?? 60_000);
      while (server.state.kind === 'stopping') {
        if (Date.now() > deadline) throw new HttpError(409, 'llama-server is taking too long to stop: try again');
        await sleep(POLL_MS);
      }
      const s = server.state;
      if (s.kind === 'external')
        throw new HttpError(409, `An external llama-server is running on port ${s.port}: stop it first`);
      if (s.kind === 'starting' || s.kind === 'ready') {
        if (!o.stopServer)
          throw new HttpError(
            409,
            `llama-server is running (profile ${s.profile}): it will be stopped during the benchmark, then restarted`,
            'server-running',
          );
        const cmd = server.lastCommand;
        this.deps.logs.push('[bench] stopping llama-server for the benchmark');
        this.stopped = cmd;
        this.stopping = server.stop().then(
          () => {
            this.stopping = null;
          },
          (e) => {
            // Not stopped: nothing to restart, the failure surfaces in the first run.
            this.stopping = null;
            this.stopped = null;
            throw e;
          },
        );
        this.stopping.catch(() => {});
      }
    } catch (e) {
      this.holding = false;
      throw e;
    }
  }

  /** Waits for the server stop to finish (rejects if it failed). */
  async ready(): Promise<void> {
    await this.stopping;
  }

  /**
   * Restarts the stopped server and releases the gate. Idempotent. Rejects with “could not restart llama-server: …”
   * if the restart fails (the gate is released anyway). `rebuild` gives the command from the profile as it is now, so
   * edits saved during the benchmark apply (#39); the recorded command is the fallback (profile deleted, no rebuild).
   */
  release(rebuild?: (stopped: BuiltCommand) => BuiltCommand | null): Promise<void> {
    if (!this.holding) return Promise.resolve();
    if (this.releasing) return this.releasing;
    this.pending = null;
    this.releasing = (async () => {
      await this.stopping?.catch(() => {});
      const stopped = this.stopped;
      this.stopped = null;
      using _free = defer(() => {
        this.holding = false;
        this.releasing = null;
      });
      if (!stopped) return;
      let cmd = stopped;
      try {
        cmd = rebuild?.(stopped) ?? stopped;
      } catch {}
      this.deps.logs.push(`[bench] restarting llama-server (${cmd.profileName})`);
      try {
        await this.deps.server.start(cmd);
      } catch (e) {
        const msg = `could not restart llama-server: ${(e as Error).message}`;
        this.deps.logs.push(`[bench] ${msg}`);
        throw new Error(msg);
      }
    })();
    return this.releasing;
  }

  /** Reload of the old module: releases once `after` settles and the delay has elapsed, unless adopt() comes first. */
  releaseLater(after: Promise<unknown>): void {
    if (!this.holding || this.releasing) return;
    const settled = Promise.allSettled([after]).then(() => {});
    const token = { cancelled: false, settled };
    this.pending = token;
    void settled
      .then(() => sleep(this.deps.adoptGraceMs ?? 3000))
      .then(() => {
        if (token.cancelled || this.pending !== token) return;
        this.pending = null;
        this.release().catch(() => {});
      });
  }

  /**
   * New module: takes over a gate left by the old one (cancels the deferred release). Returns the promise of the old
   * process finishing (to await before restarting anything on the cards), null if there is nothing to take over.
   */
  adopt(): Promise<void> | null {
    if (!this.holding || !this.pending || this.releasing) return null;
    const { settled } = this.pending;
    this.pending.cancelled = true;
    this.pending = null;
    return settled;
  }
}
