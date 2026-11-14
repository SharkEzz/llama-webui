// The server's entry point: from source (`node server/main.ts`) and in the build (`.output/server/index.mjs`).
import { Effect, Layer } from 'effect';
import { App } from './App.ts';
import { AppConfig } from './config/AppConfig.ts';
import { type CliFlags, cli } from './config/Cli.ts';
import { loadDotEnv } from './config/DotEnv.ts';
import { assertFree } from './http/Address.ts';
import { runApp } from './runtime/runApp.ts';

/**
 * The order is the point: `.env` is applied before the configuration is read (the default `ConfigProvider` takes its
 * snapshot of the environment on first use), the address is checked before anything touches the data directory.
 */
const start = (flags: CliFlags) =>
  loadDotEnv({ override: flags.envOverride }).pipe(
    Effect.andThen(
      Layer.launch(App.pipe(Layer.provide(Layer.effectDiscard(assertFree)), Layer.provide(AppConfig.layerWith(flags)))),
    ),
  );

runApp(cli(start));
