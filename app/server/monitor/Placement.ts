import type { ModelPlacement, ServerState } from '@llama-webui/shared';
import { Array as Arr, Context, Effect, Equal, Layer, Option, Ref, Stream } from 'effect';
import { LogRing } from '../logs/LogRing.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { WsHub } from '../ws/WsHub.ts';
import { parsePlacement, RELEVANT } from './placementLog.ts';

/** What the placement holds: the last state seen, the placement it published, the last one read and its pid. */
interface Held {
  readonly state: ServerState;
  readonly current: ModelPlacement | null;
  readonly last: Option.Option<{ readonly pid: number; readonly placement: ModelPlacement }>;
}

/**
 * How the managed llama-server's model is split across the devices, read from the log ring and followed as it changes.
 * The ring only keeps the latest lines: once the launch line is evicted (request logs, -lv 4), the last placement read
 * stays valid while the server of the same pid runs. An external server writes nothing to the ring: its placement is
 * unknown even when the ring still holds an old launch.
 */
export class Placement extends Context.Service<
  Placement,
  {
    /** The placement of the managed server, null when none runs or before its launch line. */
    readonly current: Effect.Effect<ModelPlacement | null>;
  }
>()('@llama-webui/app/server/monitor/Placement') {
  /**
   * Reads the placement from the ring and the state once (no message), then follows the supervisor's changes and the
   * ring's batches that hold a line that can change it; each new placement is published as `placement`.
   */
  static readonly layer: Layer.Layer<Placement, never, Supervisor | LogRing | WsHub> = Layer.effect(
    Placement,
    Effect.gen(function* () {
      const supervisor = yield* Supervisor;
      const ring = yield* LogRing;
      const hub = yield* WsHub;
      // Subscribed before the first reading: no change between the two is missed.
      const changes = yield* supervisor.changes;
      const batches = yield* ring.batches;

      /** What to hold once the placement is read again, with `state` as the supervisor's state. */
      const reread = (held: Held, state: ServerState): Effect.Effect<Held> => {
        // Only starting, ready and stopping are a managed server (idle, crashed: none; external: no logs).
        if (state.kind !== 'starting' && state.kind !== 'ready' && state.kind !== 'stopping') {
          return Effect.succeed({ state, current: null, last: Option.none() });
        }
        return Effect.map(ring.since(0), (lines): Held => {
          const parsed = parsePlacement(lines);
          if (parsed !== null) {
            return { state, current: parsed, last: Option.some({ pid: state.pid, placement: parsed }) };
          }
          const kept = Option.filter(held.last, (last) => last.pid === state.pid);
          return { state, current: Option.getOrNull(Option.map(kept, (last) => last.placement)), last: kept };
        });
      };

      const now = yield* supervisor.state;
      const initial = yield* reread({ state: now, current: null, last: Option.none() }, now);
      const held = yield* Ref.make(initial);

      /** Reads the placement again, on a new state or with the last one seen; a new placement is published. */
      const follow = Effect.fnUntraced(function* (change: Option.Option<ServerState>) {
        const before = yield* Ref.get(held);
        const next = yield* reread(
          before,
          Option.getOrElse(change, () => before.state),
        );
        yield* Ref.set(held, next);
        if (!Equal.equals(next.current, before.current)) {
          yield* hub.publish({ type: 'placement', payload: next.current });
        }
      });

      yield* Stream.merge(
        Stream.map(changes, Option.some),
        batches.pipe(
          Stream.filter(Arr.some((line) => RELEVANT.test(line.text))),
          Stream.map(() => Option.none<ServerState>()),
        ),
      ).pipe(Stream.runForEach(follow), Effect.forkScoped);

      return Placement.of({ current: Effect.map(Ref.get(held), (h) => h.current) });
    }),
  );
}
