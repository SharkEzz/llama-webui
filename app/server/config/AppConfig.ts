import { Config, Context, Effect, Layer, Path } from 'effect';

/** Where the app listens and keeps its data. */
export class AppConfig extends Context.Service<
  AppConfig,
  {
    /** `LLAMA_WEBUI_HOST`, `127.0.0.1` by default: local only. */
    readonly host: string;
    /** `LLAMA_WEBUI_PORT`, 7860 by default. */
    readonly port: number;
    /** `LLAMA_WEBUI_DATA_DIR`, else `$XDG_DATA_HOME/llama-webui`, else `~/.local/share/llama-webui`. Not created here. */
    readonly dataDir: string;
    /** `LLAMA_WEBUI_DEV=1`: the server runs from source under `pnpm dev`. */
    readonly dev: boolean;
  }
>()('@llama-webui/app/server/config/AppConfig') {
  /** From the environment and the defaults (an empty variable counts as unset). */
  static readonly layer: Layer.Layer<AppConfig, Config.ConfigError> = Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dataHome = Config.String('XDG_DATA_HOME').pipe(
        Config.orElse(() => Config.String('HOME').pipe(Config.map((home) => path.join(home, '.local', 'share')))),
      );
      return yield* Config.all({
        host: Config.String('LLAMA_WEBUI_HOST').pipe(Config.withDefault('127.0.0.1')),
        port: Config.Port('LLAMA_WEBUI_PORT').pipe(Config.withDefault(7860)),
        dataDir: Config.String('LLAMA_WEBUI_DATA_DIR').pipe(
          Config.orElse(() => dataHome.pipe(Config.map((dir) => path.join(dir, 'llama-webui')))),
        ),
        dev: Config.Boolean('LLAMA_WEBUI_DEV').pipe(Config.withDefault(false)),
      });
    }),
  ).pipe(Layer.provide(Path.layer));
}
