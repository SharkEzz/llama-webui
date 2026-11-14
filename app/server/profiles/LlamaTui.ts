import { type ProfileInput, parseProfileImport } from '@llama-webui/shared';
import { Config, Context, Effect, FileSystem, Layer, Option, Path, Predicate, Schema } from 'effect';
import { homeDir } from '../config/Home.ts';

/** The llama-tui config as the import reads it. */
export interface LlamaTuiConfig {
  readonly path: string;
  /** Whether a file is at the path (a directory is not a config). */
  readonly exists: boolean;
  /** The config's `defaultProfile` when it is a string. */
  readonly defaultProfile: string | undefined;
  readonly profiles: ReadonlyArray<ProfileInput>;
  readonly rejected: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
  /** Why the file could not be used: `Invalid JSON: <message>`, also for a file that cannot be read. */
  readonly error?: string;
}

const parseJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The config of llama-tui, the terminal UI llama-webui imports its profiles from. */
export class LlamaTui extends Context.Service<
  LlamaTui,
  {
    /**
     * `$XDG_CONFIG_HOME/llama-tui/config.json` when the variable is set and not empty, else
     * `<home>/.config/llama-tui/config.json` (llama-tui's own rule). Read at each call.
     */
    readonly path: Effect.Effect<string>;
    /** The config at `path`: a missing file is `exists: false`, a file that cannot be read or parsed has `error`. */
    readonly read: Effect.Effect<LlamaTuiConfig>;
  }
>()('@llama-webui/app/server/profiles/LlamaTui') {
  static readonly layer: Layer.Layer<LlamaTui, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
    LlamaTui,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;

      const configHome = Effect.gen(function* () {
        const xdg = yield* Config.option(Config.String('XDG_CONFIG_HOME')).pipe(Effect.orDie);
        if (Option.isSome(xdg)) return xdg.value;
        const home = yield* homeDir;
        return paths.join(home, '.config');
      });

      const path = configHome.pipe(
        Effect.map((base) => paths.join(base, 'llama-tui', 'config.json')),
        Effect.withSpan('LlamaTui.path'),
      );

      const read = Effect.gen(function* () {
        const file = yield* path;
        const empty = { path: file, defaultProfile: undefined, profiles: [], rejected: [] };
        const info = yield* Effect.option(fs.stat(file));
        if (!Option.exists(info, (stat) => stat.type === 'File')) return { ...empty, exists: false };
        const raw = yield* fs.readFileString(file).pipe(Effect.flatMap(parseJson), Effect.result);
        if (raw._tag === 'Failure') return { ...empty, exists: true, error: `Invalid JSON: ${raw.failure.message}` };
        const config = raw.success;
        const defaultProfile =
          Predicate.isObject(config) && Predicate.isString(config.defaultProfile) ? config.defaultProfile : undefined;
        return { path: file, exists: true, defaultProfile, ...parseProfileImport(config) };
      }).pipe(Effect.withSpan('LlamaTui.read'));

      return LlamaTui.of({ path, read });
    }),
  );
}
