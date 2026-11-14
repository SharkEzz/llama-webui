import { Config, Context, Effect, Layer, Option, Path } from 'effect';
import type { CliFlags } from './Cli.ts';

/** A flag that was given, else `config`. */
const flagOr = <A>(flag: Option.Option<A>, config: Config.Config<A>): Config.Config<A> =>
  Option.match(flag, { onNone: () => config, onSome: Config.succeed });

const noFlags: CliFlags = { host: Option.none(), port: Option.none(), dataDir: Option.none(), envOverride: false };

/** Where the app listens and keeps its data. */
export class AppConfig extends Context.Service<
  AppConfig,
  {
    /** `--host`, else `LLAMA_WEBUI_HOST`, else `127.0.0.1`: local only. */
    readonly host: string;
    /** `--port`, else `LLAMA_WEBUI_PORT`, else 7860. */
    readonly port: number;
    /**
     * `--data-dir`, else `LLAMA_WEBUI_DATA_DIR`, else `$XDG_DATA_HOME/llama-webui`, else `~/.local/share/llama-webui`.
     * Not created here.
     */
    readonly dataDir: string;
    /** `LLAMA_WEBUI_DEV=1`: the server runs from source under `pnpm dev`. */
    readonly dev: boolean;
  }
>()('@llama-webui/app/server/config/AppConfig') {
  /** A flag wins over its variable, a variable over the default (an empty variable counts as unset). */
  static readonly layerWith = (flags: CliFlags): Layer.Layer<AppConfig, Config.ConfigError> =>
    Layer.effect(
      AppConfig,
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const dataHome = Config.String('XDG_DATA_HOME').pipe(
          Config.orElse(() => Config.String('HOME').pipe(Config.map((home) => path.join(home, '.local', 'share')))),
        );
        return yield* Config.all({
          host: flagOr(flags.host, Config.String('LLAMA_WEBUI_HOST').pipe(Config.withDefault('127.0.0.1'))),
          port: flagOr(flags.port, Config.Port('LLAMA_WEBUI_PORT').pipe(Config.withDefault(7860))),
          dataDir: flagOr(
            flags.dataDir,
            Config.String('LLAMA_WEBUI_DATA_DIR').pipe(
              Config.orElse(() => dataHome.pipe(Config.map((dir) => path.join(dir, 'llama-webui')))),
            ),
          ),
          dev: Config.Boolean('LLAMA_WEBUI_DEV').pipe(Config.withDefault(false)),
        });
      }),
    ).pipe(Layer.provide(Path.layer));

  /** From the environment and the defaults, without flags. */
  static readonly layer: Layer.Layer<AppConfig, Config.ConfigError> = AppConfig.layerWith(noFlags);
}
