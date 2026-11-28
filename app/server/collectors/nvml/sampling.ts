/*
 * The rounds of the NVML sampler (`worker.ts`), NVML aside: the interval and what to read, set by the server's
 * commands, and the loop that reads a round and sends it. The round is given (`read`), so the loop runs without
 * `node:ffi` (`sampling.test.ts`, on the `TestClock`).
 */
import { Clock, Effect, Predicate, Ref, Schema } from 'effect';
import { type GpuNeeds, type GpuPollConfig, MEASURE_ALL } from '../gpu.ts';
import type { FromSampler, NvmlSnapshot } from './protocol.ts';

/** NVML could not be opened, or a reading failed. */
export class NvmlFailed extends Schema.TaggedError<NvmlFailed, { readonly NvmlFailed: unique symbol }>()('NvmlFailed', {
  message: Schema.String,
}) {}

/** The shortest interval between the starts of two rounds. */
export const MIN_INTERVAL_MS = 100;

export const failed = (cause: unknown) =>
  NvmlFailed.make({ message: Predicate.isError(cause) ? cause.message : String(cause) });

/** One round: what to read (`needs`) and the time of the round's start in, the cards' readings out. */
export type Round = (needs: GpuNeeds, at: number) => Effect.Effect<NvmlSnapshot, NvmlFailed>;

/**
 * The sampler's settings (every 1 s, every card, until `start`) and its loop. `apply` takes the interval of a command
 * (`MIN_INTERVAL_MS` at least) and what to read, from the next round. `sample(read)` samples forever: a round read
 * with the time of its start, sent, then a wait of the interval minus the round's own time (none when it took
 * longer). A round that fails ends it with its `NvmlFailed`.
 */
export const makeSampling = Effect.fnUntraced(function* (send: (message: FromSampler) => Effect.Effect<unknown>) {
  const config = yield* Ref.make<GpuPollConfig>({
    intervalMs: 1000,
    needs: MEASURE_ALL,
  });
  const apply = (command: GpuPollConfig) =>
    Ref.set(config, { intervalMs: Math.max(MIN_INTERVAL_MS, command.intervalMs), needs: command.needs });

  const sample = Effect.fnUntraced(
    function* (read: Round) {
      const t0 = yield* Clock.currentTimeMillis;
      const { needs } = yield* Ref.get(config);
      const snapshot = yield* read(needs, t0);
      yield* send({ type: 'sample', snapshot });
      const { intervalMs } = yield* Ref.get(config);
      const t1 = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Math.max(0, intervalMs - (t1 - t0)));
    },
    // Not `Effect.forever` itself: it would take the function's argument for its options.
    (effect) => Effect.forever(effect),
  );

  return { apply, sample };
});
