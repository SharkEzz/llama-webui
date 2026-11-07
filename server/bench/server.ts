import type { BenchPhase, Measure } from '@llama-webui/shared';
import { LineSplitter } from '../logs/lines';
import type { BuiltCommand } from '../supervisor/args';
import { probeHealth } from '../supervisor/health';
import { benchFailure } from './parse';
import { promptOf } from './prompt';

type Child = ReturnType<typeof Bun.spawn>;

export interface ServerTrialOptions {
  cmd: BuiltCommand;
  /** Taille du prompt mesuré (≈ jetons), jetons générés, nombre de mesures. */
  p: number;
  n: number;
  r: number;
  signal: AbortSignal;
  onPhase(phase: BenchPhase, step?: { index: number; total: number }): void;
  onLine(line: string): void;
  onSpawn(proc: Child): void;
  fetch?: typeof fetch;
  now?: () => number;
  loadTimeoutMs?: number;
  requestTimeoutMs?: number;
  killTimeoutMs?: number;
  healthPollMs?: number;
}

export interface ServerTrialResult {
  pp: Measure;
  tg: Measure;
  draftAcceptPct: number | null;
}

interface Timings {
  prompt_n?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_per_second?: number;
  draft_n?: number;
  draft_n_accepted?: number;
}

export class TrialCancelled extends Error {}

const EXIT_GRACE_MS = 2000;
const WARMUP_PROMPT = 'Bonjour.';
/** Consigne après le texte de remplissage : une génération neuve, pas une recopie. */
const STORY =
  "À partir de ce texte, écris une histoire nouvelle et originale, avec d'autres personnages et un autre lieu.";
const duration = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;

function measure(values: number[], tokens: number): Measure {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return { tps: mean, stddev: Math.sqrt(variance), tokens };
}

/**
 * Un llama-server lancé pour la mesure (adapté de `BenchRunner.trial` de llama-tui) : santé, échauffement, puis `r`
 * requêtes de chat fixes (`p` jetons de texte + consigne, `n` jetons générés). Lève une Error lisible en cas d'échec (ligne de log du serveur si elle dit pourquoi),
 * TrialCancelled sur annulation ; le serveur est toujours arrêté à la fin.
 */
export async function runServerTrial(o: ServerTrialOptions): Promise<ServerTrialResult> {
  const fetchImpl = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const loadTimeoutMs = o.loadTimeoutMs ?? 10 * 60_000;
  const requestTimeoutMs = o.requestTimeoutMs ?? 10 * 60_000;
  const killTimeoutMs = o.killTimeoutMs ?? 5000;
  const healthPollMs = o.healthPollMs ?? 500;
  const { cmd } = o;

  o.onPhase('loading');
  if ((await probeHealth(cmd.port, fetchImpl)) !== null)
    throw new Error(`port ${cmd.port} occupé par un autre serveur`);
  if (o.signal.aborted) throw new TrialCancelled();

  const tail: string[] = [];
  const push = (line: string) => {
    o.onLine(line);
    tail.push(line);
    if (tail.length > 50) tail.shift();
  };
  const proc = Bun.spawn(cmd.argv, { cwd: cmd.cwd, env: cmd.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  // Arrêté à la sortie de l'essai, quoi qu'il arrive : SIGTERM, puis SIGKILL après killTimeoutMs.
  await using _server = { [Symbol.asyncDispose]: () => stop(proc, killTimeoutMs, o.onLine) };
  o.onSpawn(proc);
  const piped = Promise.all([
    pipe(proc.stdout as ReadableStream<Uint8Array>, push),
    pipe(proc.stderr as ReadableStream<Uint8Array>, push),
  ]);
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  const exitError = async () => {
    await Promise.race([piped, Bun.sleep(200)]);
    return new Error(benchFailure(tail, proc.exitCode ?? proc.signalCode ?? '-', 'llama-server').message);
  };

  /** Une requête mesurée, non stream ; renvoie les timings de llama-server. */
  const post = async (path: string, body: Record<string, unknown>): Promise<Timings> => {
    const signal = AbortSignal.any([o.signal, AbortSignal.timeout(requestTimeoutMs)]);
    let r: Response;
    try {
      r = await fetchImpl(`http://127.0.0.1:${cmd.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, cache_prompt: false, temperature: 0, seed: 42, stream: false }),
        signal,
      });
    } catch (e) {
      if ((e as Error).name === 'TimeoutError') throw new Error(`pas de réponse après ${duration(requestTimeoutMs)}`);
      throw e;
    }
    if (r.status !== 200) {
      await r.body?.cancel().catch(() => {});
      throw new Error(`${path} a répondu ${r.status}`);
    }
    const json = (await r.json()) as { timings?: Timings };
    return json.timings ?? {};
  };

  try {
    const deadline = now() + loadTimeoutMs;
    for (;;) {
      if (o.signal.aborted) throw new TrialCancelled();
      if (exited) throw await exitError();
      if (now() > deadline) throw new Error(`chargement > ${duration(loadTimeoutMs)}`);
      if ((await probeHealth(cmd.port, fetchImpl)) === 200) break;
      await Bun.sleep(healthPollMs);
    }
    o.onPhase('warmup');
    await post('/completion', { prompt: WARMUP_PROMPT, n_predict: 16 });
    // Mesure par le chat, comme un vrai usage : un prompt brut répété ferait recopier le modèle, et le décodage
    // spéculatif (MTP) accepterait presque tous ses drafts (95 % mesurés contre ~50 % en conversation).
    const messages = [{ role: 'user', content: `${promptOf(o.p)}\n\n${STORY}` }];
    const all: Timings[] = [];
    for (let i = 0; i < o.r; i++) {
      o.onPhase('measure', { index: i + 1, total: o.r });
      all.push(
        await post('/v1/chat/completions', {
          messages,
          max_tokens: o.n,
          ignore_eos: true,
          chat_template_kwargs: { enable_thinking: false },
        }),
      );
    }
    const last = all.at(-1)!;
    const draftN = all.reduce((a, t) => a + (t.draft_n ?? 0), 0);
    const accepted = all.reduce((a, t) => a + (t.draft_n_accepted ?? 0), 0);
    return {
      pp: measure(
        all.map((t) => t.prompt_per_second ?? 0),
        last.prompt_n ?? 0,
      ),
      tg: measure(
        all.map((t) => t.predicted_per_second ?? 0),
        last.predicted_n ?? 0,
      ),
      draftAcceptPct: draftN > 0 ? Math.round((accepted / draftN) * 1000) / 10 : null,
    };
  } catch (e) {
    if (e instanceof TrialCancelled || o.signal.aborted) throw new TrialCancelled();
    // Un serveur qui meurt pendant une requête (CUDA out of memory) ferme la socket avant que sa sortie ne soit vue :
    // on lui laisse un instant, pour afficher sa propre ligne d'erreur plutôt que la connexion fermée.
    if (!exited) await Promise.race([proc.exited, Bun.sleep(EXIT_GRACE_MS)]);
    if (exited || proc.exitCode !== null || proc.signalCode !== null) throw await exitError();
    throw e;
  }
}

async function pipe(stream: ReadableStream<Uint8Array>, push: (line: string) => void): Promise<void> {
  const split = new LineSplitter();
  const dec = new TextDecoder();
  try {
    for await (const chunk of stream) for (const l of split.push(dec.decode(chunk, { stream: true }))) push(l);
  } catch {}
  for (const l of split.flush()) push(l);
}

async function stop(proc: Child, killTimeoutMs: number, onLine: (l: string) => void): Promise<void> {
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.kill('SIGTERM');
    } catch {}
    const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(killTimeoutMs).then(() => false)]);
    if (!done) {
      onLine(`pas d'arrêt après ${killTimeoutMs} ms, SIGKILL`);
      try {
        proc.kill('SIGKILL');
      } catch {}
    }
  }
  await proc.exited;
}
