import type { ServerState } from "@llama-webui/shared";
import { HttpError } from "../http";
import type { LogBuffer } from "../logs/buffer";
import type { BuiltCommand } from "../supervisor/args";

/** Ce que la garde attend du superviseur : arrêter le serveur géré avant un benchmark, le relancer après. */
export interface ServerControl {
  readonly state: ServerState;
  readonly lastCommand: BuiltCommand | null;
  stop(): Promise<void>;
  start(cmd: BuiltCommand): Promise<void>;
}

export interface GateDeps {
  server: ServerControl;
  logs: LogBuffer;
  /** Délai laissé au nouveau module pour reprendre la garde après un rechargement (3 s). */
  adoptGraceMs?: number;
  /** Attente maximale d'un arrêt déjà en cours avant de prendre la garde (60 s). */
  stoppingTimeoutMs?: number;
}

const POLL_MS = 100;

/**
 * La garde du serveur pendant les benchmarks : un seul détenteur (run ponctuel ou sweep), le serveur géré arrêté une fois
 * à la prise et relancé une fois à la libération, le détecteur de serveur externe en pause tant qu'elle est tenue.
 * Vit dans le runtime (survit à `bun --hot`) : le runner est recréé à chaque rechargement, la garde non, si bien qu'un
 * sweep reprend dans le nouveau module sans relancer le serveur entre-temps. Modifier ce fichier demande de relancer Bun.
 */
export class BenchGate {
  private holding = false;
  /** Commande du serveur effectivement arrêté par la garde, à relancer. */
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

  /** Vrai tant que l'arrêt du serveur lancé par acquire() n'est pas fini. */
  get isStopping(): boolean {
    return this.stopping !== null;
  }

  /**
   * Prend la garde. Refus (409) si elle est déjà tenue, si un serveur externe tourne, ou si le serveur géré tourne sans
   * `stopServer` (code « server-running », le client demande confirmation). Un arrêt déjà en cours est attendu (rien à
   * relancer ensuite). Sinon l'arrêt du serveur est lancé sans être attendu : `ready()` le fait.
   */
  async acquire(o: { stopServer: boolean }): Promise<void> {
    if (this.holding) throw new HttpError(409, "Un benchmark est en cours");
    this.holding = true;
    try {
      const { server } = this.deps;
      const deadline = Date.now() + (this.deps.stoppingTimeoutMs ?? 60_000);
      while (server.state.kind === "stopping") {
        if (Date.now() > deadline) throw new HttpError(409, "llama-server met trop de temps à s'arrêter : réessayez");
        await Bun.sleep(POLL_MS);
      }
      const s = server.state;
      if (s.kind === "external") throw new HttpError(409, `Un llama-server externe tourne sur le port ${s.port} : arrêtez-le d'abord`);
      if (s.kind === "starting" || s.kind === "ready") {
        if (!o.stopServer)
          throw new HttpError(409, `llama-server tourne (profil ${s.profile}) : il sera arrêté pendant le benchmark puis relancé`, "server-running");
        const cmd = server.lastCommand;
        this.deps.logs.push("[bench] arrêt de llama-server pendant le benchmark");
        this.stopped = cmd;
        this.stopping = server.stop().then(
          () => {
            this.stopping = null;
          },
          (e) => {
            // Pas arrêté : rien à relancer, l'échec remonte au premier run.
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

  /** Attend la fin de l'arrêt du serveur (rejette s'il a échoué). */
  async ready(): Promise<void> {
    await this.stopping;
  }

  /**
   * Relance le serveur arrêté et libère la garde. Idempotent. Rejette avec « relance de llama-server impossible : … »
   * si la relance échoue (la garde est libérée quand même).
   */
  release(): Promise<void> {
    if (!this.holding) return Promise.resolve();
    if (this.releasing) return this.releasing;
    this.pending = null;
    this.releasing = (async () => {
      await this.stopping?.catch(() => {});
      const cmd = this.stopped;
      this.stopped = null;
      try {
        if (cmd) {
          this.deps.logs.push(`[bench] relance de llama-server (${cmd.profileName})`);
          try {
            await this.deps.server.start(cmd);
          } catch (e) {
            const msg = `relance de llama-server impossible : ${(e as Error).message}`;
            this.deps.logs.push(`[bench] ${msg}`);
            throw new Error(msg);
          }
        }
      } finally {
        this.holding = false;
        this.releasing = null;
      }
    })();
    return this.releasing;
  }

  /** Rechargement de l'ancien module : libère quand `after` est réglé et le délai écoulé, sauf si adopt() vient avant. */
  releaseLater(after: Promise<unknown>): void {
    if (!this.holding || this.releasing) return;
    const settled = Promise.allSettled([after]).then(() => {});
    const token = { cancelled: false, settled };
    this.pending = token;
    void settled
      .then(() => Bun.sleep(this.deps.adoptGraceMs ?? 3000))
      .then(() => {
        if (token.cancelled || this.pending !== token) return;
        this.pending = null;
        this.release().catch(() => {});
      });
  }

  /**
   * Nouveau module : reprend une garde laissée par l'ancien (annule la libération différée). Renvoie la promesse de fin de
   * l'ancien process (à attendre avant de relancer quoi que ce soit sur les cartes), null si rien à reprendre.
   */
  adopt(): Promise<void> | null {
    if (!this.holding || !this.pending || this.releasing) return null;
    const { settled } = this.pending;
    this.pending.cancelled = true;
    this.pending = null;
    return settled;
  }
}
