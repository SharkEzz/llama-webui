/*
 * The NVML sampler, a program of its own (`startNvml` of `Nvml.ts` spawns it): a call stuck in the driver must not
 * hold the server, which kills this process whatever it is doing, and PCIe counters block about 50 ms per card.
 *
 * It reads `ToSampler` commands on its stdin and writes `FromSampler` messages on its stdout, one JSON value per line
 * (`protocol.ts`). On `start` it opens and inits NVML: `error` when it cannot (it then stays idle), else `ready`, then
 * one `sample` every `intervalMs` (100 ms at least, the round's own time included). `configure` changes the interval
 * and what to read from the next round. The end of its stdin (the server gone, even killed) ends it, with exit 0.
 *
 * Run as is by Node in development (relative imports with `.ts`, erasable syntax only), bundled to
 * `.output/server/nvml-worker.mjs` by `app/build/server.ts`.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { type Cause, Clock, Effect, Fiber, Predicate, Queue, Ref, Schema, Stdio, Stream } from 'effect';
import { Ndjson } from 'effect/encoding';
import { type GpuNeeds, MEASURE_ALL } from '../gpu.ts';
import { FromSampler, ToSampler } from './protocol.ts';
import { deviceHandles, readNvml } from './read.ts';
import { openNvml } from './symbols.ts';

/** NVML could not be opened, or a reading failed. */
class NvmlFailed extends Schema.TaggedError<NvmlFailed, { readonly NvmlFailed: unique symbol }>()('NvmlFailed', {
  message: Schema.String,
}) {}

const MIN_INTERVAL_MS = 100;

const failed = (cause: unknown) => NvmlFailed.make({ message: Predicate.isError(cause) ? cause.message : `${cause}` });

/** The library at `path` (else the system's), opened and initialized; shut down with the scope. */
const open = Effect.fnUntraced(function* (path: string | undefined) {
  const lib = yield* Effect.try({ try: () => openNvml(path), catch: failed });
  const rc = yield* Effect.sync(() => lib.nvmlInit_v2());
  if (rc !== 0) return yield* NvmlFailed.make({ message: `nvmlInit_v2 returned ${rc}` });
  yield* Effect.addFinalizer(() => Effect.sync(() => lib.nvmlShutdown()));
  const handles = yield* Effect.sync(() => deviceHandles(lib));
  return { lib, handles };
});

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const outbox = yield* Queue.unbounded<FromSampler, Cause.Done>();
  const writer = yield* Stream.fromQueue(outbox).pipe(
    Stream.pipeThroughChannel(Ndjson.encodeSchemaString(FromSampler)()),
    Stream.run(stdio.stdout()),
    Effect.forkScoped,
  );
  const send = (message: FromSampler) => Queue.offer(outbox, message);
  const config = yield* Ref.make<{ readonly intervalMs: number; readonly needs: GpuNeeds }>({
    intervalMs: 1000,
    needs: MEASURE_ALL,
  });
  const apply = (command: { readonly intervalMs: number; readonly needs: GpuNeeds }) =>
    Ref.set(config, { intervalMs: Math.max(MIN_INTERVAL_MS, command.intervalMs), needs: command.needs });
  const started = yield* Ref.make(false);

  /** Samples forever; each wait is the interval minus the round's time. A reading that fails ends it. */
  const sampling = (nvml: Effect.Success<ReturnType<typeof open>>) =>
    Effect.gen(function* () {
      const t0 = yield* Clock.currentTimeMillis;
      const { needs } = yield* Ref.get(config);
      const snapshot = yield* Effect.try({ try: () => readNvml(nvml.lib, nvml.handles, needs), catch: failed });
      yield* send({ type: 'sample', snapshot });
      const { intervalMs } = yield* Ref.get(config);
      const t1 = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Math.max(0, intervalMs - (t1 - t0)));
    }).pipe(Effect.forever);

  const start = Effect.fnUntraced(
    function* (command: Extract<ToSampler, { readonly type: 'start' }>) {
      if (yield* Ref.getAndSet(started, true)) return;
      yield* apply(command);
      const nvml = yield* open(command.lib);
      yield* send({ type: 'ready' });
      yield* sampling(nvml).pipe(
        Effect.catchTag('NvmlFailed', (e) => send({ type: 'error', message: e.message })),
        Effect.forkScoped,
      );
    },
    Effect.catchTag('NvmlFailed', (e) => send({ type: 'error', message: e.message })),
  );

  yield* stdio.stdin.pipe(
    Stream.pipeThroughChannel(Ndjson.decodeSchema(ToSampler)({ ignoreEmptyLines: true })),
    Stream.runForEach((command) => (command.type === 'start' ? start(command) : apply(command))),
  );
  // The server is gone: the messages already queued leave, then the scope stops the sampling and NVML.
  yield* Queue.end(outbox);
  yield* Fiber.join(writer);
}).pipe(Effect.scoped);

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
