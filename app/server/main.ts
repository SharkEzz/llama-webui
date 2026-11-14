// The server's entry point: from source (`node server/main.ts`) and in the build (`.output/server/index.mjs`).
import { NodeRuntime } from '@effect/platform-node';
import { Cause, Exit, Layer } from 'effect';
import { App } from './App.ts';
import { AppConfig } from './config/AppConfig.ts';

NodeRuntime.runMain(Layer.launch(App.pipe(Layer.provide(AppConfig.layer))), {
  // A stop on a signal is a normal end: 0, not runMain's 130.
  teardown: (exit, onExit) => onExit(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1),
});
