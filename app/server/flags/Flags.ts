import { FlagsUnavailable } from '@llama-webui/shared';
import { Cache, Context, Duration, Effect, Exit, Layer, Path, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import type { FlagCatalog } from 'llamacpp-js/flags';
import { parseHelp } from 'llamacpp-js/flags';
import { expandHome } from '../config/Home.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';

/** How long `--help` may run, and how much it may print. */
const HELP_TIMEOUT = '5 seconds';
const MAX_OUTPUT = 16 * 1024 * 1024;

/** The flags of the configured llama-server, from its `--help`. */
export class Flags extends Context.Service<
  Flags,
  {
    /** The flags of the `binary` setting's `--help` (`~` expanded), read once per binary path for the life of the app. */
    readonly catalog: Effect.Effect<FlagCatalog, FlagsUnavailable>;
  }
>()('@llama-webui/app/server/flags/Flags') {
  static readonly layer: Layer.Layer<Flags, never, SettingsRepo | ChildProcessSpawner.ChildProcessSpawner | Path.Path> =
    Layer.effect(
      Flags,
      Effect.gen(function* () {
        const settings = yield* SettingsRepo;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const paths = yield* Path.Path;

        /** `<binary> --help` parsed; the reason it gave no catalogue is not kept, only that it gave none. */
        const readHelp = Effect.fn('Flags.readHelp')(
          function* (binary: string) {
            const handle = yield* spawner.spawn(
              ChildProcess.make(binary, ['--help'], { stdin: 'ignore', stderr: 'ignore', forceKillAfter: '1 second' }),
            );
            let size = 0;
            const capped = Stream.mapEffect(handle.stdout, (chunk) => {
              size += chunk.length;
              return size > MAX_OUTPUT ? Effect.fail('more than 16 MiB of output') : Effect.succeed(chunk);
            });
            const [text, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(capped)), handle.exitCode], {
              concurrency: 2,
            });
            if (code !== 0) return yield* Effect.fail(`exit code ${code}`);
            const catalog = parseHelp(text);
            return catalog.flags.length > 0 ? catalog : yield* Effect.fail('no flag listed');
          },
          Effect.scoped,
          Effect.timeout(HELP_TIMEOUT),
          (effect, binary) =>
            Effect.mapError(effect, () => FlagsUnavailable.make({ message: `llama-server --help failed (${binary})` })),
        );

        // A success stays for the life of the app; a failure is not kept, so the next call runs `--help` again.
        const cache = yield* Cache.makeWith(readHelp, {
          capacity: Number.MAX_SAFE_INTEGER,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
        });

        const catalog = Effect.gen(function* () {
          const { binary } = yield* settings.get;
          const path = yield* Effect.provideService(expandHome(binary), Path.Path, paths);
          return yield* Cache.get(cache, path);
        }).pipe(Effect.withSpan('Flags.catalog'));

        return Flags.of({ catalog });
      }),
    );
}
