/*
 * The NVML sampler, a program of its own (`startNvml` of `Nvml.ts` spawns it): a call stuck in the driver must not
 * hold the server, which kills this process whatever it is doing, and PCIe counters block about 50 ms per card.
 *
 * It reads `ToSampler` commands on its stdin and writes `FromSampler` messages on its stdout, one JSON value per line
 * (`protocol.ts`). On `start` it opens and inits NVML: `error` when it cannot (it then stays idle), else `ready`, then
 * one `sample` every `intervalMs` (100 ms at least, the round's own time included), read at the time of its start, by
 * which the reader keeps its slow values for their period (`read.ts`; the loop is `sampling.ts`). `configure` changes
 * the interval and what to read from the next round. The end of its stdin (the server gone, even killed) ends it, with exit 0.
 *
 * Run as is by Node in development (relative imports with `.ts`, erasable syntax only), bundled to
 * `.output/server/nvml-worker.mjs` by `app/build/server.ts`.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { type Cause, Effect, Fiber, Queue, Ref, Stdio, Stream } from 'effect';
import { Ndjson } from 'effect/encoding';
import { FromSampler, ToSampler } from './protocol.ts';
import { deviceHandles, nvmlReader } from './read.ts';
import { failed, makeSampling, NvmlFailed } from './sampling.ts';
import { openNvml } from './symbols.ts';

/**
 * The library at `path` (else the system's), opened and initialized, and the reader of its cards; shut down with the
 * scope.
 */
const open = Effect.fnUntraced(function* (path: string | undefined) {
  const lib = yield* Effect.try({ try: () => openNvml(path), catch: failed });
  const rc = yield* Effect.sync(() => lib.nvmlInit_v2());
  if (rc !== 0) return yield* NvmlFailed.make({ message: `nvmlInit_v2 returned ${rc}` });
  yield* Effect.addFinalizer(() => Effect.sync(() => lib.nvmlShutdown()));
  return yield* Effect.sync(() => nvmlReader(lib, deviceHandles(lib)));
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
  const sampling = yield* makeSampling(send);
  const started = yield* Ref.make(false);

  const start = Effect.fnUntraced(
    function* (command: Extract<ToSampler, { readonly type: 'start' }>) {
      if (yield* Ref.getAndSet(started, true)) return;
      yield* sampling.apply(command);
      const read = yield* open(command.lib);
      yield* send({ type: 'ready' });
      // Each round is one synchronous read of NVML (`read.ts`).
      yield* sampling
        .sample((needs, at) => Effect.try({ try: () => read(needs, at), catch: failed }))
        .pipe(
          Effect.catchTag('NvmlFailed', (e) => send({ type: 'error', message: e.message })),
          Effect.forkScoped,
        );
    },
    Effect.catchTag('NvmlFailed', (e) => send({ type: 'error', message: e.message })),
  );

  yield* stdio.stdin.pipe(
    Stream.pipeThroughChannel(Ndjson.decodeSchema(ToSampler)({ ignoreEmptyLines: true })),
    Stream.runForEach((command) => (command.type === 'start' ? start(command) : sampling.apply(command))),
  );
  // The server is gone: the messages already queued leave, then the scope stops the sampling and NVML.
  yield* Queue.end(outbox);
  yield* Fiber.join(writer);
}).pipe(Effect.scoped);

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
