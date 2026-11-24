import type { ModelPlacement, ServerState } from '@llama-webui/shared';
import { Array as Arr, Context, Effect, Equal, type FileSystem, Layer, Option, type Path, Ref, Stream } from 'effect';
import type { ModelMemory } from 'llamacpp-js/models';
import { LogRing } from '../logs/LogRing.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { WsHub } from '../ws/WsHub.ts';
import { parseBusIds, parsePlacement, RELEVANT } from './placementLog.ts';
import { placementFromMemory, readSysfsGpus, type SysfsGpu } from './placementMemory.ts';

/**
 * What the placement holds: the last state and SSE memory seen, the published placement, and the last placement read
 * of a pid (from its logs, or from `/models/sse` with what its logs told).
 */
interface Held {
  readonly state: ServerState;
  readonly memory: ModelMemory | null;
  readonly current: ModelPlacement | null;
  readonly last: Option.Option<{ readonly pid: number; readonly placement: ModelPlacement }>;
  /** A managed model is asleep or has yet to finish waking up. */
  readonly suspended: boolean;
}

/** The PCI address of each device of `placement` that has one. */
const busIdsOf = (placement: ModelPlacement | null): ReadonlyMap<string, string> =>
  new Map(
    Arr.flatMap(placement?.buffers ?? [], (buffer) =>
      buffer.busId === null ? [] : [[buffer.device, buffer.busId] as const],
    ),
  );

/** `state` without its loading `progress`. */
const withoutProgress = (state: ServerState): ServerState => {
  if (!('progress' in state)) return state;
  const { progress: _, ...rest } = state;
  return rest;
};

type Event =
  | { readonly kind: 'state'; readonly state: ServerState }
  | { readonly kind: 'memory'; readonly memory: ModelMemory | null }
  | { readonly kind: 'logs' };

/**
 * How the active llama-server's model is split across devices, read from the log ring (primary, with PCI busIds,
 * layer counts and P2P) and falling back to `/models/sse` `data.memory` when startup buffer logs are missing
 * (external server, profile with `-lv < 4`, or evicted ring). While sleeping, the model is unloaded from VRAM so the
 * placement is null.
 */
export class Placement extends Context.Service<
  Placement,
  {
    /** The placement of the active server, null when none runs, while sleeping, or before any placement is known. */
    readonly current: Effect.Effect<ModelPlacement | null>;
  }
>()('@llama-webui/app/server/monitor/Placement') {
  /** Builds `Placement` with an injectable sysfs GPU list (for tests). */
  static readonly layerWith = (options: {
    readonly gpus: Effect.Effect<ReadonlyArray<SysfsGpu>>;
  }): Layer.Layer<Placement, never, Supervisor | LogRing | WsHub> =>
    Layer.effect(
      Placement,
      Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        const ring = yield* LogRing;
        const hub = yield* WsHub;
        const gpus = yield* options.gpus;
        // Subscribed before the first reading: no change between the two is missed.
        const changes = yield* supervisor.changes;
        const memoryChanges = yield* supervisor.memoryChanges;
        const batches = yield* ring.batches;

        /** What to hold once the placement is recomputed from `state`, `memory` and the log ring. */
        const reread = (held: Held, state: ServerState, memory: ModelMemory | null): Effect.Effect<Held> => {
          const next = { state, memory, suspended: false };
          if (state.kind === 'idle' || state.kind === 'crashed') {
            return Effect.succeed({ ...next, current: null, last: Option.none() });
          }
          if (state.kind === 'external') {
            const fromSse =
              state.status === 'sleeping' || memory === null ? null : placementFromMemory({ memory, gpus });
            return Effect.succeed({ ...next, current: fromSse, last: Option.none() });
          }
          const kept = Option.filter(held.last, (last) => last.pid === state.pid);
          if (
            state.kind === 'sleeping' ||
            (state.kind !== 'ready' && held.suspended && 'pid' in held.state && held.state.pid === state.pid)
          ) {
            return Effect.succeed({ ...next, current: null, last: kept, suspended: true });
          }
          return Effect.map(ring.since(0), (lines): Held => {
            const remembered = (placement: ModelPlacement): Held => ({
              ...next,
              current: placement,
              last: Option.some({ pid: state.pid, placement }),
            });
            const parsed = parsePlacement(lines);
            if (parsed !== null && parsed.buffers.length > 0) return remembered(parsed);
            // The launch line left the ring: what was read of this server while it was there stands.
            const known = parsed === null ? Option.map(kept, (last) => last.placement) : Option.none();
            if (Option.exists(known, (p) => p.source !== 'sse' && p.buffers.length > 0)) {
              return { ...next, current: Option.getOrNull(known), last: kept };
            }
            // What the logs told beside the sizes (the launch, the layers, P2P, the PCI addresses), with the sizes of
            // `/models/sse`.
            const logs = parsed ?? Option.getOrNull(known);
            if (memory !== null) {
              const fromSse = placementFromMemory({
                memory,
                busIds: parsed === null ? busIdsOf(logs) : parseBusIds(lines),
                gpus,
                ...(logs === null
                  ? {}
                  : {
                      launchSeq: logs.launchSeq,
                      layers: logs.layers,
                      ...(logs.p2p === undefined ? {} : { p2p: logs.p2p }),
                    }),
              });
              if (fromSse !== null) return remembered(fromSse);
            }
            if (parsed !== null) return remembered(parsed);
            // Sizes of `/models/sse` without its memory are of a model that is no longer loaded.
            return { ...next, current: Option.getOrNull(Option.filter(known, (p) => p.source !== 'sse')), last: kept };
          });
        };

        const nowState = yield* supervisor.state;
        const nowMemory = yield* supervisor.memory;
        const initial = yield* reread(
          { state: nowState, memory: nowMemory, current: null, last: Option.none(), suspended: false },
          nowState,
          nowMemory,
        );
        const held = yield* Ref.make(initial);

        /** Recomputes placement on any state, memory or relevant log batch; publishes when changed. */
        const follow = Effect.fnUntraced(function* (event: Event) {
          const before = yield* Ref.get(held);
          // A new loading progress alone changes nothing of the placement: no reread of the ring.
          if (event.kind === 'state' && Equal.equals(withoutProgress(event.state), withoutProgress(before.state))) {
            yield* Ref.set(held, { ...before, state: event.state });
            return;
          }
          const nextState = event.kind === 'state' ? event.state : before.state;
          const nextMemory = event.kind === 'memory' ? event.memory : before.memory;
          const next = yield* reread(before, nextState, nextMemory);
          yield* Ref.set(held, next);
          if (!Equal.equals(next.current, before.current)) {
            yield* hub.publish({ type: 'placement', payload: next.current });
          }
        });

        yield* Stream.mergeAll(
          [
            Stream.map(changes, (state): Event => ({ kind: 'state', state })),
            Stream.map(memoryChanges, (memory): Event => ({ kind: 'memory', memory })),
            batches.pipe(
              Stream.filter(Arr.some((line) => RELEVANT.test(line.text))),
              Stream.map((): Event => ({ kind: 'logs' })),
            ),
          ],
          { concurrency: 'unbounded' },
        ).pipe(Stream.runForEach(follow), Effect.forkScoped);

        return Placement.of({ current: Effect.map(Ref.get(held), (h) => h.current) });
      }),
    );

  /** Reads placement from the log ring and `/models/sse`, resolving single-GPU PCI busIds from sysfs. */
  static readonly layer: Layer.Layer<
    Placement,
    never,
    Supervisor | LogRing | WsHub | FileSystem.FileSystem | Path.Path
  > = Layer.unwrap(
    Effect.gen(function* () {
      const ctx = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      return Placement.layerWith({ gpus: readSysfsGpus().pipe(Effect.provideContext(ctx)) });
    }),
  );
}
