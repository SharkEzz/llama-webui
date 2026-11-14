import { classifyLine, type LogLine } from '@llama-webui/shared';
import { Array as Arr, Context, Effect, Layer, Option, Queue, SynchronizedRef } from 'effect';
import { WsHub } from '../ws/WsHub.ts';

/** The lines held and the number of the next one. */
interface Held {
  readonly lines: ReadonlyArray<LogLine>;
  readonly next: number;
}

/** llama-server's log in memory (nothing is written to disk): the last lines, numbered from 0 on each boot. */
export class LogRing extends Context.Service<
  LogRing,
  {
    /** Numbers a line, classifies it, keeps it and queues it for the next `log` message. */
    readonly push: (text: string) => Effect.Effect<void>;
    /** The lines still held whose number is at least `seq`. */
    readonly since: (seq: number) => Effect.Effect<ReadonlyArray<LogLine>>;
    /** The number of the next line. */
    readonly seq: Effect.Effect<number>;
  }
>()('@llama-webui/app/server/logs/LogRing') {
  /** A ring of the last `capacity` lines; a fiber publishes what was pushed since its last turn as one `log` message. */
  static readonly layerWith = (options: { readonly capacity: number }) =>
    Layer.effect(
      LogRing,
      Effect.gen(function* () {
        const hub = yield* WsHub;
        const held = yield* SynchronizedRef.make<Held>({ lines: [], next: 0 });
        const unpublished = yield* Queue.unbounded<LogLine>();

        yield* Queue.takeAll(unpublished).pipe(
          Effect.flatMap((batch) => hub.publish({ type: 'log', payload: batch })),
          Effect.forever,
          Effect.forkScoped,
        );

        const push = Effect.fn('LogRing.push')(function* (text: string) {
          // Numbered and queued in one step: no other push comes between, so the messages keep the order.
          yield* SynchronizedRef.updateEffect(held, ({ lines, next }) => {
            const line: LogLine = { seq: next, text, ...classifyLine(text) };
            return Queue.offer(unpublished, line).pipe(
              Effect.as({ lines: Arr.takeRight(Arr.append(lines, line), options.capacity), next: next + 1 }),
            );
          });
        });

        const since = Effect.fn('LogRing.since')(function* (seq: number) {
          const { lines, next } = yield* SynchronizedRef.get(held);
          const first = Arr.head(lines).pipe(
            Option.map((line) => line.seq),
            Option.getOrElse(() => next),
          );
          return Arr.drop(lines, seq - first);
        });

        return { push, since, seq: Effect.map(SynchronizedRef.get(held), (h) => h.next) };
      }),
    );

  /** The last 10 000 lines. */
  static readonly layer: Layer.Layer<LogRing, never, WsHub> = LogRing.layerWith({ capacity: 10_000 });
}
