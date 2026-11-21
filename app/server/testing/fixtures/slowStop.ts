// `node slowStop.ts <ms>`: an app whose stop takes <ms>; prints `ready` once up, `undone` once its stop is done.
import { Console, Effect, Layer } from 'effect';
import { runApp } from '../../runtime/runApp.ts';

const ms = Number(process.argv[2] ?? '100');

const Slow = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sleep(ms).pipe(Effect.andThen(Console.log('undone'))));
    yield* Console.log('ready');
  }),
);

runApp(Layer.launch(Slow));
