import type { BenchPhase, Measure } from '@llama-webui/shared';
import { Array as Arr, Clock, Deferred, Duration, Effect, Exit, Option, Ref, Schema, Scope, Stream } from 'effect';
import { HttpClientRequest, HttpClientResponse } from 'effect/http';
import { ChildProcess, type ChildProcessSpawner } from 'effect/process';
import { ERROR_LINE } from 'llamacpp-js/bench';
import { LlamaHttp } from '../llama/LlamaHttp.ts';
import { health } from '../llama/probes.ts';
import { linesOf } from '../logs/lines.ts';
import { type Ending, endingOf } from '../process/ending.ts';
import { FORCE_KILL_AFTER, type Followed, followProgram } from '../process/followed.ts';
import type { BuiltCommand } from '../supervisor/command.ts';
import { draftAcceptPct, measure } from './measure.ts';
import { benchFailure } from './parse.ts';
import { promptOf, STORY, WARMUP_PROMPT } from './prompt.ts';

/** Why a trial gave no measure: a readable message (the server's own error line when it said why). */
export class TrialFailed extends Schema.TaggedError<TrialFailed, { readonly TrialFailed: unique symbol }>()(
  'TrialFailed',
  { message: Schema.String },
) {}

export interface TrialResult {
  readonly pp: Measure;
  readonly tg: Measure;
  readonly draftAcceptPct: number | null;
}

/** The timings llama-server answers a request with; what is missing reads as 0. */
const Timings = Schema.Struct({
  prompt_n: Schema.optionalKey(Schema.Finite),
  prompt_per_second: Schema.optionalKey(Schema.Finite),
  predicted_n: Schema.optionalKey(Schema.Finite),
  predicted_per_second: Schema.optionalKey(Schema.Finite),
  draft_n: Schema.optionalKey(Schema.Finite),
  draft_n_accepted: Schema.optionalKey(Schema.Finite),
});
type Timings = typeof Timings.Type;
const Answer = Schema.Struct({ timings: Schema.optionalKey(Timings) });

/** How long a server that broke a request may take to exit, for its own error line to be read. */
const EXIT_GRACE = '2 seconds';
/** The lines kept for the failure message, and the error lines kept apart (a backtrace can bury them). */
const TAIL = 50;
const ERRORS = 10;

/** `10 min`, `5 s`, `200 ms`. */
export const duration = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;

/**
 * Stops a program the way the supervisor does: SIGTERM, then, `killTimeout` later, `say` the SIGKILL and send it; done
 * once its exit was handled.
 */
export const stopGently = Effect.fn('bench.stopGently')(function* (options: {
  readonly program: Followed;
  readonly killTimeout: Duration.Input;
  readonly say: (text: string) => Effect.Effect<void>;
}) {
  const { handle } = options.program;
  const killTimeout = Duration.fromInputUnsafe(options.killTimeout);
  // The wait is made interruptible for the timeout to end it.
  const stopped = yield* handle
    .kill({ killSignal: 'SIGTERM' })
    .pipe(Effect.ignore, Effect.interruptible, Effect.timeoutOption(killTimeout));
  if (Option.isNone(stopped)) {
    yield* options.say(`not stopped after ${Duration.toMillis(killTimeout)} ms, SIGKILL`);
    yield* handle.kill({ killSignal: 'SIGKILL' }).pipe(Effect.ignore);
  }
  yield* options.program.ended;
});

/**
 * A llama-server started for the measurement (from llama-tui's `BenchRunner.trial`): `/health` until it loaded, a
 * warm-up, then `r` fixed chat requests (`p` tokens of text and an instruction, `n` generated tokens), every request
 * through `LlamaHttp`. Fails with a readable message (the server's log line when it says why). The server is stopped at
 * the end: SIGTERM, then SIGKILL after `killTimeout` (`say` tells it); an interruption (llama-webui stopping) kills
 * it at once.
 */
export const runTrial = Effect.fn('trial.runTrial')(function* (options: {
  readonly cmd: BuiltCommand;
  readonly p: number;
  readonly n: number;
  readonly r: number;
  readonly onPhase: (
    phase: BenchPhase,
    step: { readonly index: number; readonly total: number } | null,
  ) => Effect.Effect<void>;
  readonly onLine: (line: string) => Effect.Effect<void>;
  readonly onSpawn: (program: Followed) => Effect.Effect<void>;
  readonly say: (text: string) => Effect.Effect<void>;
  readonly killTimeout: Duration.Input;
  readonly loadTimeout?: Duration.Input;
  readonly requestTimeout?: Duration.Input;
  readonly healthPoll?: Duration.Input;
}): Effect.fn.Return<TrialResult, TrialFailed, LlamaHttp | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> {
  const { cmd } = options;
  const scope = yield* Scope.Scope;
  const client = yield* LlamaHttp;
  const loadTimeout = Duration.toMillis(Duration.fromInputUnsafe(options.loadTimeout ?? '10 minutes'));
  const requestTimeout = Duration.fromInputUnsafe(options.requestTimeout ?? '10 minutes');
  const healthPoll = options.healthPoll ?? '500 millis';
  const target = { host: '127.0.0.1', port: cmd.port };

  yield* options.onPhase('loading', null);
  const before = yield* health(target);
  if (Option.isSome(before)) return yield* TrialFailed.make({ message: `port ${cmd.port} is used by another server` });

  const tail = yield* Ref.make<ReadonlyArray<string>>([]);
  const errors = yield* Ref.make<ReadonlyArray<string>>([]);
  const push = Effect.fnUntraced(function* (line: string) {
    yield* options.onLine(line);
    yield* Ref.update(tail, (lines) => Arr.takeRight(Arr.append(lines, line), TAIL));
    if (ERROR_LINE.test(line)) yield* Ref.update(errors, (lines) => Arr.takeRight(Arr.append(lines, line), ERRORS));
  });
  const exit = yield* Deferred.make<Ending>();
  const read = (bytes: Stream.Stream<Uint8Array, unknown>) =>
    linesOf(bytes).pipe(Stream.runForEach(push), Effect.ignore);
  const [binary = '', ...args] = cmd.argv;
  const program = yield* followProgram({
    command: ChildProcess.make(binary, args, {
      cwd: cmd.cwd,
      env: { ...cmd.env },
      extendEnv: true,
      stdin: 'ignore',
      // An interruption (llama-webui stopping) kills at once; a stop of the trial is `stopGently`.
      killSignal: 'SIGKILL',
      forceKillAfter: FORCE_KILL_AFTER,
    }),
    parent: scope,
    name: 'llama-server',
    onSpawn: options.onSpawn,
    read: ({ handle }) => Effect.all([read(handle.stdout), read(handle.stderr)], { concurrency: 2, discard: true }),
    onExit: (ended) => Deferred.succeed(exit, endingOf(ended)),
  }).pipe(Effect.mapError((error) => TrialFailed.make({ message: error.message })));

  /** The failure of a server that exited: its error lines first, then its last lines. */
  const exitError = Effect.gen(function* () {
    const ending = yield* Deferred.await(exit);
    const lines = [...(yield* Ref.get(errors)), ...(yield* Ref.get(tail))];
    const code = ending.code ?? ending.signal ?? '-';
    return TrialFailed.make({ message: benchFailure({ lines, exit: code, tool: 'llama-server' }).message });
  });

  /** A measured request, not streamed: llama-server's timings. */
  const post = Effect.fnUntraced(
    function* (path: string, body: Readonly<Record<string, unknown>>) {
      const request = yield* HttpClientRequest.post(`http://127.0.0.1:${cmd.port}${path}`).pipe(
        HttpClientRequest.bodyJson({ ...body, cache_prompt: false, temperature: 0, seed: 42, stream: false }),
        Effect.orDie,
      );
      const res = yield* client
        .execute(request)
        .pipe(Effect.mapError((error) => TrialFailed.make({ message: error.message })));
      if (res.status !== 200) return yield* TrialFailed.make({ message: `${path} responded ${res.status}` });
      const answer = yield* HttpClientResponse.schemaBodyJson(Answer)(res).pipe(
        Effect.orElseSucceed((): typeof Answer.Type => ({})),
      );
      const timings: Timings = answer.timings ?? {};
      return timings;
    },
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: requestTimeout,
      orElse: () =>
        Effect.fail(TrialFailed.make({ message: `no response after ${duration(Duration.toMillis(requestTimeout))}` })),
    }),
  );

  const measured = Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + loadTimeout;
    for (;;) {
      if (yield* Deferred.isDone(exit)) return yield* yield* exitError;
      if ((yield* Clock.currentTimeMillis) > deadline)
        return yield* TrialFailed.make({ message: `loading > ${duration(loadTimeout)}` });
      const status = yield* health(target);
      if (Option.contains(status, 200)) break;
      yield* Effect.sleep(healthPoll);
    }
    yield* options.onPhase('warmup', null);
    yield* post('/completion', { prompt: WARMUP_PROMPT, n_predict: 16 });
    // Measured through chat, like real use: a repeated raw prompt would make the model copy it, and speculative
    // decoding (MTP) would accept almost all its drafts (95% measured versus ~50% in conversation).
    const messages = [{ role: 'user', content: `${promptOf(options.p)}\n\n${STORY}` }];
    const all = yield* Effect.forEach(Arr.range(1, options.r), (index) =>
      options.onPhase('measure', { index, total: options.r }).pipe(
        Effect.andThen(
          post('/v1/chat/completions', {
            messages,
            max_tokens: options.n,
            ignore_eos: true,
            chat_template_kwargs: { enable_thinking: false },
          }),
        ),
      ),
    );
    const last = Arr.last(all).pipe(Option.getOrElse((): Timings => ({})));
    const result: TrialResult = {
      pp: measure({ values: Arr.map(all, (t) => t.prompt_per_second ?? 0), tokens: last.prompt_n ?? 0 }),
      tg: measure({ values: Arr.map(all, (t) => t.predicted_per_second ?? 0), tokens: last.predicted_n ?? 0 }),
      draftAcceptPct: draftAcceptPct({
        drafted: Arr.reduce(all, 0, (sum, t) => sum + (t.draft_n ?? 0)),
        accepted: Arr.reduce(all, 0, (sum, t) => sum + (t.draft_n_accepted ?? 0)),
      }),
    };
    return result;
  }).pipe(
    // A server that dies during a request (CUDA out of memory) closes the socket before its output is seen: give it a
    // moment, to show its own error line rather than the closed connection.
    Effect.catch((failure) =>
      Effect.gen(function* () {
        yield* Deferred.await(exit).pipe(Effect.timeoutOption(EXIT_GRACE));
        const exited = yield* Deferred.isDone(exit);
        return yield* exited ? yield* exitError : failure;
      }),
    ),
  );

  return yield* measured.pipe(
    Effect.onExit((ended) =>
      Exit.hasInterrupts(ended)
        ? program.stop
        : stopGently({ program, killTimeout: options.killTimeout, say: options.say }),
    ),
  );
});
