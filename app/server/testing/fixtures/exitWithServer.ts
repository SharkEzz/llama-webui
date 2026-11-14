// `node exitWithServer.ts`: starts the fake llama-server under the supervisor, prints its pid once it is ready, then
// ends the process with `process.exit(1)`, which runs no finalizer: only the supervisor's last resort is left.
import { DEFAULT_SETTINGS, type Profile } from '@llama-webui/shared';
import { Console, Effect, Layer, Schedule } from 'effect';
import { LlamaHttp } from '../../llama/LlamaHttp.ts';
import { LogRing } from '../../logs/LogRing.ts';
import { runApp } from '../../runtime/runApp.ts';
import { buildCommand } from '../../supervisor/command.ts';
import { Supervisor } from '../../supervisor/Supervisor.ts';
import { WsHub } from '../../ws/WsHub.ts';
import { FAKE, freePort } from '../llama.ts';

/** A hub with no client. */
const SilentHub = Layer.succeed(WsHub, {
  publish: () => Effect.void,
  size: Effect.succeed(0),
  attach: () => Effect.void,
});

const Supervised = Supervisor.layer.pipe(
  Layer.provideMerge(Layer.merge(LogRing.layer, LlamaHttp.layer)),
  Layer.provide(SilentHub),
);

/** Ends the process at once, as an uncaught error would. */
function exitNow(): never {
  process.exit(1);
}

const program = Effect.gen(function* () {
  const supervisor = yield* Supervisor;
  const port = yield* freePort;
  const profile: Profile = {
    id: 1,
    name: 'fake',
    model: 'm.gguf',
    args: [],
    env: { FAKE_LOAD_MS: '0' },
    port,
    source: 'ui',
    createdAt: 0,
    updatedAt: 0,
  };
  const cmd = yield* buildCommand({ profile, settings: { ...DEFAULT_SETTINGS, binary: FAKE } });
  yield* supervisor.start(cmd);
  const ready = yield* supervisor.state.pipe(
    Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (state) => state.kind === 'ready' }),
  );
  yield* Console.log(ready.kind === 'ready' ? ready.pid : -1);
  return yield* Effect.sync(exitNow);
});

runApp(Layer.launch(Layer.effectDiscard(program).pipe(Layer.provide(Supervised))));
