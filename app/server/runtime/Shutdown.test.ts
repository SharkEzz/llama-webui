import { assert, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Ref } from 'effect';
import { Shutdown } from './Shutdown.ts';

/** The shape of `App`: the runner outermost, a layer under it (the HTTP server), `Shutdown.layer` under both. */
const app = (log: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.merge(
    Shutdown.layerRunner.pipe(
      Layer.provide(Layer.effectDiscard(Effect.addFinalizer(() => Ref.update(log, (l) => [...l, 'server undone'])))),
      Layer.provide(Shutdown.layer),
    ),
    Shutdown.layer,
  );

/** Builds the app, registers the steps, then undoes it. */
const withApp = (
  log: Ref.Ref<ReadonlyArray<string>>,
  register: (shutdown: Shutdown['Service']) => Effect.Effect<void>,
) => Layer.build(app(log)).pipe(Effect.map(Context.get(Shutdown)), Effect.flatMap(register), Effect.scoped);

const push = (log: Ref.Ref<ReadonlyArray<string>>, entry: string) => Ref.update(log, (l) => [...l, entry]);

it.effect('steps run when the scope closes, last registered first', () =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* withApp(log, (shutdown) =>
      Effect.gen(function* () {
        yield* shutdown.before(push(log, 'first registered'));
        yield* shutdown.before(push(log, 'last registered'));
        const before = yield* Ref.get(log);
        assert.deepStrictEqual(before, []);
      }),
    );
    // Before the layers built under the runner are undone.
    const after = yield* Ref.get(log);
    assert.deepStrictEqual(after, ['last registered', 'first registered', 'server undone']);
  }),
);

it.effect('a step that fails does not stop the next ones', () =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<string>>([]);
    const exit = yield* withApp(log, (shutdown) =>
      Effect.gen(function* () {
        yield* shutdown.before(push(log, 'a'));
        yield* shutdown.before(Effect.die('boom'));
        yield* shutdown.before(push(log, 'c'));
      }),
    ).pipe(Effect.exit);
    assert.isTrue(Exit.isSuccess(exit));
    const after = yield* Ref.get(log);
    assert.deepStrictEqual(after, ['c', 'a', 'server undone']);
  }),
);
