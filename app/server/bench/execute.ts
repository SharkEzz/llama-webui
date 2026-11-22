import type { BenchKind, BenchLive, BenchSpec, GpuSample, Profile } from '@llama-webui/shared';
import { benchArgs, serverArgs, shellQuote } from '@llama-webui/shared';
import {
  Array as Arr,
  Clock,
  Deferred,
  type Duration,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Ref,
  Schedule,
  Scope,
  Stream,
} from 'effect';
import { ChildProcess, type ChildProcessSpawner } from 'effect/process';
import { parseBenchJson, parseBenchProgress } from 'llamacpp-js/bench';
import { benchBinary } from 'llamacpp-js/node';
import { expandHome } from '../config/Home.ts';
import type { LlamaHttp } from '../llama/LlamaHttp.ts';
import { linesOf } from '../logs/lines.ts';
import { LogRing } from '../logs/LogRing.ts';
import { causeMessage, endingOf } from '../process/ending.ts';
import { FORCE_KILL_AFTER, type Followed, followProgram } from '../process/followed.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { type BuiltCommand, buildCommand } from '../supervisor/command.ts';
import type { BenchFinish } from './BenchRunsRepo.ts';
import { benchFailure } from './parse.ts';
import { runTrial, stopGently } from './trial.ts';
import { startVramProbe } from './vram.ts';

/** What a run gives back: its status and measures, its VRAM and disk peaks, its log tail, its duration. */
export type ExecResult = BenchFinish &
  Required<Pick<BenchFinish, 'status' | 'vramPeak' | 'logExcerpt' | 'durationMs' | 'diskReadPeakBps'>>;

/** A run's command: what it runs, how it shows, and for a server run the command of its llama-server. */
export interface RunCommand {
  readonly argv: ReadonlyArray<string>;
  readonly display: string;
  readonly server: Option.Option<BuiltCommand>;
}

/** The lines kept for the run's excerpt and its failure message; the live view shows the last 20. */
const TAIL = 50;
const LIVE_LINES = 20;
/** The monitor's snapshots read during a run (the fast probe is the first source). */
const SAMPLE = '500 millis';
const MIB = 1024 * 1024;

/** The directory and the variables of the run's source profile; none when it has none or it is gone. */
const sourceOf = Effect.fn('execute.sourceOf')(function* (spec: BenchSpec) {
  const profiles = yield* ProfilesRepo;
  if (spec.profileId === null) return Option.none<Profile>();
  return yield* profiles.get(spec.profileId).pipe(Effect.option);
});

/**
 * A run's command. Server: the model, the projector, the flags of the fields then the other flags, on 127.0.0.1 and
 * the settings' port, in the directory and with the variables of the source profile (its flags may name relative
 * paths); through `buildCommand`. Bench: `llama-bench` next to the `binary` setting (`~` expanded).
 */
export const commandOf = Effect.fn('execute.commandOf')(function* (spec: BenchSpec) {
  const settings = yield* (yield* SettingsRepo).get;
  const source = yield* sourceOf(spec);
  if (spec.kind === 'server') {
    const path = yield* Path.Path;
    const profile: Profile = {
      id: spec.profileId ?? 0,
      name: 'bench',
      model: spec.modelPath,
      ...(spec.mmprojPath === null || spec.mmprojPath === '' ? {} : { mmproj: spec.mmprojPath }),
      cwd: Option.flatMap(source, (s) => Option.fromNullishOr(s.cwd)).pipe(
        Option.getOrElse(() => path.dirname(spec.modelPath)),
      ),
      host: '127.0.0.1',
      args: [...serverArgs(spec.params), ...spec.serverArgs],
      env: Option.match(source, { onNone: () => ({}), onSome: (s) => s.env }),
      source: 'ui',
      createdAt: 0,
      updatedAt: 0,
    };
    const cmd = yield* buildCommand({ profile, settings });
    const command: RunCommand = { argv: cmd.argv, display: cmd.display, server: Option.some(cmd) };
    return command;
  }
  const expanded = yield* expandHome(settings.binary);
  const binary = benchBinary(expanded);
  const bench = [
    binary,
    '-m',
    spec.modelPath,
    '-o',
    'json',
    '--progress',
    '-r',
    `${spec.r}`,
    '-p',
    `${spec.p}`,
    '-n',
    `${spec.n}`,
    ...benchArgs(spec.params),
  ];
  const command: RunCommand = {
    argv: ['setpriv', '--pdeathsig', 'KILL', '--', ...bench],
    display: shellQuote(bench),
    server: Option.none(),
  };
  return command;
});

/** The run being executed, as `execute` needs it: its id, its kind and its stored command. */
export interface ExecutedRun {
  readonly id: number;
  readonly kind: BenchKind;
  readonly command: string;
}

/**
 * Executes a run (llama-bench or a trial llama-server) already saved as `running`, in the caller's scope, and returns
 * its result without writing it. Does not touch the managed server: that is the gate's. `spec` is the requested one
 * (the saved run loses a profile id whose profile is gone). `onLive` gets every change of the phase, the step and the
 * last lines, with `lines` true when only new lines changed it (the runner throttles those). `cancel`, once completed, stops the program: SIGTERM, then
 * `[llama-webui] not stopped after <ms> ms, SIGKILL` and SIGKILL after `killTimeout`; the result is then `cancelled`.
 * `gpus` and `disk` are the monitor's: the VRAM peak is what each card holds above its value at the start (the fast
 * probe, then the monitor's snapshots as a fallback), the disk peak the model disk's read bandwidth.
 */
export const execute = Effect.fn('execute.execute')(function* (options: {
  readonly run: ExecutedRun;
  readonly spec: BenchSpec;
  readonly startedAt: number;
  readonly onLive: (live: BenchLive, lines: boolean) => Effect.Effect<void>;
  readonly killTimeout: Duration.Input;
  readonly cancel: Deferred.Deferred<void>;
  readonly gpus: Effect.Effect<ReadonlyArray<GpuSample>>;
  readonly disk: Effect.Effect<number | null>;
  readonly loadTimeout?: Duration.Input;
}): Effect.fn.Return<
  ExecResult,
  never,
  | SettingsRepo
  | ProfilesRepo
  | LogRing
  | LlamaHttp
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope
> {
  const { spec, run } = options;
  const ring = yield* LogRing;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Scope.Scope;
  const t0 = yield* Clock.currentTimeMillis;
  const live = yield* Ref.make<BenchLive>({
    runId: run.id,
    kind: run.kind,
    phase: 'loading',
    step: null,
    startedAt: options.startedAt,
    lines: [],
  });
  const tail = yield* Ref.make<ReadonlyArray<string>>([]);
  const cancelled = yield* Ref.make(false);
  const current = yield* Ref.make(Option.none<Followed>());

  const setLive = (
    patch: Partial<Pick<BenchLive, 'phase' | 'step'>> & { readonly loadProgress?: BenchLive['loadProgress'] | null },
    lines = false,
  ) =>
    Ref.updateAndGet(live, (l): BenchLive => {
      const nextPhase = patch.phase ?? l.phase;
      const nextStep = patch.step !== undefined ? patch.step : l.step;
      const nextProgress =
        patch.loadProgress === null
          ? undefined
          : (patch.loadProgress ?? (nextPhase === 'loading' ? l.loadProgress : undefined));
      return {
        runId: l.runId,
        kind: l.kind,
        phase: nextPhase,
        step: nextStep,
        startedAt: l.startedAt,
        lines: l.lines,
        ...(nextProgress === undefined ? {} : { loadProgress: nextProgress }),
      };
    }).pipe(Effect.flatMap((l) => options.onLive(l, lines)));
  const line = Effect.fnUntraced(function* (text: string) {
    yield* ring.push(`[bench] ${text}`);
    const lines = yield* Ref.updateAndGet(tail, (t) => Arr.takeRight(Arr.append(t, text), TAIL));
    yield* Ref.update(live, (l) => ({ ...l, lines: Arr.takeRight(lines, LIVE_LINES) }));
  });
  const say = (text: string) => ring.push(`[llama-webui] ${text}`);

  // The VRAM and disk samplers, ended (with a last reading) when the work ends.
  const peaks = yield* Ref.make<ReadonlyMap<string, { readonly name: string; readonly bytes: number }>>(new Map());
  const diskPeak = yield* Ref.make<number | null>(null);
  const note = (key: string, name: string, bytes: number) =>
    Ref.update(peaks, (map) => {
      const was = map.get(key);
      return was !== undefined && bytes <= was.bytes ? map : new Map(map).set(key, { name, bytes });
    });
  const sampled = Effect.gen(function* () {
    const first = yield* options.gpus;
    const before = new Map(Arr.map(first, (g) => [g.key, g.vramUsedBytes] as const));
    const sample = Effect.gen(function* () {
      const gpus = yield* options.gpus;
      yield* Effect.forEach(gpus, (g) => note(g.key, g.name, Math.max(0, g.vramUsedBytes - (before.get(g.key) ?? 0))), {
        discard: true,
      });
      const disk = yield* options.disk;
      if (disk !== null) yield* Ref.update(diskPeak, (peak) => (peak === null || disk > peak ? disk : peak));
    });
    const probe = yield* startVramProbe(first);
    const sampler = yield* sample.pipe(
      Effect.repeat(Schedule.spaced(SAMPLE)),
      Effect.delay(SAMPLE),
      Effect.forkIn(scope),
    );
    const end = Effect.gen(function* () {
      yield* Fiber.interrupt(sampler);
      yield* sample;
      yield* probe.stop;
      const readings = yield* probe.readings;
      yield* Effect.forEach(
        first,
        (g) =>
          Option.match(Option.fromNullishOr(readings.get(g.key)), {
            onNone: () => Effect.void,
            onSome: (r) => note(g.key, g.name, Math.max(0, r.max - r.first)),
          }),
        { discard: true },
      );
    });
    return yield* Effect.succeed(end);
  });
  const sampling = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      sampled,
      () => work,
      (end) => end,
    );

  /** The program of the run, followed: a cancel stops it, one spawned after a cancel is stopped at once. */
  const spawned = Effect.fnUntraced(function* (program: Followed) {
    yield* Ref.set(current, Option.some(program));
    if (yield* Ref.get(cancelled))
      yield* stopGently({ program, killTimeout: options.killTimeout, say }).pipe(Effect.forkIn(scope));
  });

  const runBench = Effect.fnUntraced(function* (argv: ReadonlyArray<string>) {
    const settings = yield* (yield* SettingsRepo).get;
    const source = yield* sourceOf(spec);
    yield* ring.push(`[bench] ${run.command}`);
    const stdout = yield* Ref.make('');
    const exit = yield* Deferred.make<ReturnType<typeof endingOf>>();
    const [binary = '', ...args] = argv;
    const program = yield* followProgram({
      command: ChildProcess.make(binary, args, {
        // The settings' variables then the source profile's (CUDA_VISIBLE_DEVICES…: the same cards as the server).
        env: { ...settings.env, ...Option.match(source, { onNone: () => ({}), onSome: (s) => s.env }) },
        extendEnv: true,
        stdin: 'ignore',
        killSignal: 'SIGKILL',
        forceKillAfter: FORCE_KILL_AFTER,
      }),
      parent: scope,
      name: 'llama-bench',
      onSpawn: spawned,
      read: ({ handle }) =>
        Effect.all(
          [
            handle.stdout.pipe(
              Stream.decodeText,
              Stream.mkString,
              Effect.flatMap((out) => Ref.set(stdout, out)),
              Effect.ignore,
            ),
            linesOf(handle.stderr).pipe(
              Stream.runForEach((text) =>
                Effect.gen(function* () {
                  yield* line(text);
                  const progress = parseBenchProgress(text);
                  if (progress === null) return yield* setLive({}, true);
                  const runs = progress.runs ?? spec.r;
                  yield* setLive({
                    phase: progress.phase,
                    step: { index: (progress.test - 1) * runs + (progress.run ?? 0), total: progress.tests * runs },
                  });
                }),
              ),
              Effect.ignore,
            ),
          ],
          { concurrency: 2, discard: true },
        ),
      onExit: (ended) => Deferred.succeed(exit, endingOf(ended)),
    }).pipe(Effect.result);
    if (program._tag === 'Failure') {
      const failed: BenchFinish = { status: 'failed', error: causeMessage(program.failure) };
      return failed;
    }
    const ending = yield* Deferred.await(exit);
    yield* program.success.ended;
    const out = yield* Ref.get(stdout);
    const parsed = ending.code === 0 ? parseBenchJson(out) : null;
    if (parsed !== null && (parsed.pp !== null || parsed.tg !== null)) {
      const ok: BenchFinish = { status: 'ok', pp: parsed.pp, tg: parsed.tg };
      return ok;
    }
    const lines = yield* Ref.get(tail);
    const failed: BenchFinish = {
      status: 'failed',
      error: benchFailure({ lines, exit: ending.code ?? ending.signal ?? '?' }).message,
    };
    return failed;
  });

  const runServer = Effect.fnUntraced(function* (cmd: BuiltCommand) {
    yield* ring.push(`[bench] ${cmd.display}`);
    const trial = yield* runTrial({
      cmd,
      p: spec.p,
      n: spec.n,
      r: spec.r,
      onPhase: (phase, step) => setLive({ phase, step, ...(phase === 'loading' ? {} : { loadProgress: null }) }),
      onLoadProgress: (loadProgress) => setLive({ loadProgress }),
      onLine: (text) => line(text).pipe(Effect.andThen(setLive({}, true))),
      onSpawn: spawned,
      say,
      killTimeout: options.killTimeout,
      ...(options.loadTimeout === undefined ? {} : { loadTimeout: options.loadTimeout }),
    }).pipe(Effect.result);
    if (trial._tag === 'Failure') {
      const failed: BenchFinish = { status: 'failed', error: trial.failure.message };
      return failed;
    }
    const ok: BenchFinish = {
      status: 'ok',
      pp: trial.success.pp,
      tg: trial.success.tg,
      draftAcceptPct: trial.success.draftAcceptPct,
    };
    return ok;
  });

  const work = Effect.gen(function* () {
    yield* setLive({});
    const found = yield* fs.exists(spec.modelPath).pipe(Effect.orElseSucceed(() => false));
    if (!found) {
      const missing: BenchFinish = { status: 'failed', error: `Model not found: ${spec.modelPath}` };
      return missing;
    }
    const command = yield* commandOf(spec);
    if (Option.isSome(command.server)) return yield* sampling(runServer(command.server.value));
    return yield* sampling(runBench(command.argv));
  });

  // A cancel: its line, then the program stopped gently; the work is interrupted once it is gone (an interrupted trial
  // kills what is left at once).
  const cancelling = Effect.gen(function* () {
    yield* Deferred.await(options.cancel);
    yield* Ref.set(cancelled, true);
    yield* line('cancellation requested');
    yield* setLive({});
    const program = yield* Ref.get(current);
    if (Option.isSome(program)) yield* stopGently({ program: program.value, killTimeout: options.killTimeout, say });
    const stopped: BenchFinish = { status: 'cancelled' };
    return stopped;
  });

  const ended = yield* Effect.raceFirst(work, cancelling);
  const finish: BenchFinish = (yield* Ref.get(cancelled)) ? { status: 'cancelled' } : ended;
  const vramPeak = Arr.filter(
    Arr.map(Array.from((yield* Ref.get(peaks)).entries()), ([key, p]) => ({
      key,
      name: p.name,
      mib: Math.round(p.bytes / MIB),
    })),
    (p) => p.mib > 0,
  );
  const lines = yield* Ref.get(tail);
  const now = yield* Clock.currentTimeMillis;
  const disk = yield* Ref.get(diskPeak);
  const result: ExecResult = {
    error: null,
    ...finish,
    status: finish.status ?? 'failed',
    vramPeak,
    logExcerpt: Arr.join(lines, '\n'),
    durationMs: now - t0,
    diskReadPeakBps: disk,
  };
  return result;
});
