import { assert, layer } from '@effect/vitest';
import type { WsMessage } from '@llama-webui/shared';
import { Array as Arr, Context, Effect, Layer, Ref, Schedule } from 'effect';
import { WsHub } from '../ws/WsHub.ts';
import { LogRing } from './LogRing.ts';

/** What the hub of the test was given to publish, in order. */
class Published extends Context.Service<Published, Ref.Ref<ReadonlyArray<WsMessage>>>()(
  '@llama-webui/app/server/logs/LogRing.test/Published',
) {}

/** A hub that records what is published. */
const RecordingHub = Layer.effect(
  WsHub,
  Effect.gen(function* () {
    const published = yield* Published;
    return {
      publish: (message: WsMessage) => Ref.update(published, Arr.append(message)),
      size: Effect.succeed(0),
      attach: () => Effect.void,
    };
  }),
);

/** A ring of `capacity` lines on the recording hub. */
const ringOf = (capacity: number) =>
  LogRing.layerWith({ capacity }).pipe(
    Layer.provide(RecordingHub),
    Layer.provideMerge(Layer.effect(Published, Ref.make<ReadonlyArray<WsMessage>>([]))),
  );

const pushAll = (texts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const ring = yield* LogRing;
    yield* Effect.forEach(texts, ring.push, { discard: true });
  });

const texts = (seq: number) =>
  Effect.gen(function* () {
    const ring = yield* LogRing;
    const lines = yield* ring.since(seq);
    return Arr.map(lines, (line) => line.text);
  });

layer(ringOf(10_000), { excludeTestServices: true, buildPerTest: true })('LogRing', (it) => {
  it.effect('lines are numbered from 0 and classified', () =>
    Effect.gen(function* () {
      yield* pushAll(['0.00.000.000 E srv  main: cannot load', '0.00.000.001 I slot launch: x', 'request failed']);
      const lines = yield* (yield* LogRing).since(0);
      assert.deepStrictEqual(lines, [
        { seq: 0, text: '0.00.000.000 E srv  main: cannot load', level: 'error', kind: 'srv' },
        { seq: 1, text: '0.00.000.001 I slot launch: x', level: 'info', kind: 'slot' },
        { seq: 2, text: 'request failed', level: 'error', kind: 'other' },
      ]);
    }),
  );

  it.effect('what was pushed is published as log messages, every line once, in order', () =>
    Effect.gen(function* () {
      const published = yield* Published;
      const seqs = (messages: ReadonlyArray<WsMessage>) =>
        Arr.flatMap(messages, (message) =>
          message.type === 'log' ? Arr.map(message.payload, (line) => line.seq) : [],
        );
      yield* pushAll(Arr.makeBy(10, (i) => `line ${i}`));
      const all = yield* Ref.get(published).pipe(
        Effect.map(seqs),
        Effect.repeat({ schedule: Schedule.spaced('5 millis'), until: (got) => got.length >= 10 }),
      );
      assert.deepStrictEqual(all, Arr.range(0, 9));
    }),
  );
});

layer(ringOf(3), { excludeTestServices: true })('LogRing of 3 lines', (it) => {
  it.effect('since keeps the lines whose number is at least the one asked, and the ring forgets the oldest', () =>
    Effect.gen(function* () {
      yield* pushAll(['l0', 'l1', 'l2', 'l3', 'l4']);
      const fromStart = yield* texts(0);
      const fromLast = yield* texts(4);
      const beyond = yield* texts(9);
      const next = yield* (yield* LogRing).seq;
      assert.deepStrictEqual(fromStart, ['l2', 'l3', 'l4']);
      assert.deepStrictEqual(fromLast, ['l4']);
      assert.deepStrictEqual(beyond, []);
      assert.strictEqual(next, 5);
    }),
  );
});
