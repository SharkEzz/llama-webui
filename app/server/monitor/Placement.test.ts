import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import {
  DEFAULT_SETTINGS,
  type ModelPlacement,
  type Profile,
  type ServerState,
  type WsMessage,
} from '@llama-webui/shared';
import {
  Array as Arr,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  type Scope,
  String as Str,
} from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { LlamaHttp } from '../llama/LlamaHttp.ts';
import { isAlive } from '../llama/procScan.ts';
import { LogRing } from '../logs/LogRing.ts';
import { buildCommand } from '../supervisor/command.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { FAKE, fakeOutside, freePort } from '../testing/llama.ts';
import { WsHub } from '../ws/WsHub.ts';
import { Placement } from './Placement.ts';

const MiB = 1024 ** 2;

/** What the hub of the test was given to publish, in order. */
class Published extends Context.Service<Published, Ref.Ref<ReadonlyArray<WsMessage>>>()(
  '@llama-webui/app/server/monitor/Placement.test/Published',
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

/** The supervisor with a short poll, on a ring of `capacity` lines, the client, a recording hub and Node. */
const supervisorOn = (capacity: number) =>
  Supervisor.layerWith({ killTimeout: '2 seconds', healthPoll: '50 millis' }).pipe(
    Layer.provideMerge(Layer.mergeAll(LogRing.layerWith({ capacity }), LlamaHttp.layer)),
    Layer.provideMerge(RecordingHub),
    Layer.provideMerge(Layer.effect(Published, Ref.make<ReadonlyArray<WsMessage>>([]))),
    Layer.provideMerge(NodeServices.layer),
  );

type Services =
  | Supervisor
  | LogRing
  | WsHub
  | Published
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope;

/** `test` on a supervisor of its own and a ring of `capacity` lines, ended (its server stopped) with the test. */
const fresh =
  (capacity: number) =>
  <A, E>(test: Effect.Effect<A, E, Services>) =>
    Layer.build(supervisorOn(capacity)).pipe(
      Effect.flatMap((context) => Effect.provideContext(test, context)),
      Effect.scoped,
    );

/** The placement, built now on what the test's scope holds. */
const buildPlacement = Layer.build(Placement.layer).pipe(Effect.map(Context.get(Placement)));

let nextId = 1;

/** Starts the fake on a free port, its `env` holding the `FAKE_*` variables. */
const startFake = (env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor;
    const profile: Profile = {
      id: nextId++,
      name: 'fake',
      model: 'm.gguf',
      args: [],
      env: { ...env },
      port: yield* freePort,
      source: 'ui',
      createdAt: 0,
      updatedAt: 0,
    };
    const cmd = yield* buildCommand({ profile, settings: { ...DEFAULT_SETTINGS, binary: FAKE } });
    yield* supervisor.start(cmd);
  });

/** The lines of `testdata/llama-server-load.txt`, its launch line first. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(path.resolve(import.meta.dirname, '../../../testdata/llama-server-load.txt'));
  return Str.split(Str.trimEnd(text), '\n');
});

const pushAll = (texts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const ring = yield* LogRing;
    yield* Effect.forEach(texts, ring.push, { discard: true });
  });

/** The placements published, in order. */
const placements = Effect.gen(function* () {
  const published = yield* Published;
  const messages = yield* Ref.get(published);
  return Arr.flatMap(
    messages,
    (message): ReadonlyArray<ModelPlacement | null> => (message.type === 'placement' ? [message.payload] : []),
  );
});

/** Every 10 ms until `ok` holds, for 5 s at most. */
const when =
  <A>(ok: (a: A) => boolean) =>
  <E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: ok }), Effect.timeout('5 seconds'));

const stateWhen = (ok: (state: ServerState) => boolean) =>
  Effect.flatMap(Supervisor, (supervisor) => supervisor.state.pipe(when(ok)));

/** The pid a state names, -1 when it names none. */
const pidOf = (state: ServerState): number => ('pid' in state && state.pid !== null ? state.pid : -1);

const assertGone = (pid: number) => Effect.map(isAlive(pid), (alive) => assert.isTrue(pid > 0 && !alive, `${pid}`));

const sizes = Arr.map((p: ModelPlacement | null) => (p === null ? null : p.buffers.length));

const bufferOf = (p: ModelPlacement | null, device: string) =>
  Arr.findFirst(p?.buffers ?? [], (b) => b.device === device);

/** llama.cpp's prefix of a line (“0.00.000.493 I ”) taken off. */
const withoutPrefix = Str.replace(/^\d+\.\d+(?:\.\d+)*\s+[IWEDT]\s+/, '');

layer(NodeServices.layer, { excludeTestServices: true })('Placement', (it) => {
  it.effect(
    'Placement: replays the ring at construction without a message, follows new lines and the server state',
    () =>
      fresh(100)(
        Effect.gen(function* () {
          const supervisor = yield* Supervisor;
          const lines = yield* fixture;
          yield* startFake();
          yield* pushAll(lines);

          const placement = yield* buildPlacement;
          const replayed = yield* placement.current;
          assert.deepStrictEqual(replayed?.layers, { offloaded: 49, total: 49 });
          const atConstruction = yield* placements;
          assert.deepStrictEqual(atConstruction, []);

          // A line that changes nothing, then one that does.
          yield* pushAll([
            'srv  log_server_r: request: POST /completion',
            'load_tensors:        CUDA1 model buffer size =     1.00 MiB',
          ]);
          const grown = yield* placements.pipe(when((ps) => ps.length >= 1));
          // The same five devices, CUDA1 grew: a change.
          assert.deepStrictEqual(sizes(grown), [5]);
          const current = yield* placement.current;
          assert.deepStrictEqual(current, grown[0]);
          assert.deepStrictEqual(
            Option.map(bufferOf(current, 'CUDA1'), (b) => b.modelBytes),
            Option.some((11715.43 + 1) * MiB),
          );

          const ready = yield* stateWhen((state) => state.kind === 'ready');
          yield* supervisor.stop;
          const stopped = yield* placements.pipe(when((ps) => ps.length >= 2));
          assert.deepStrictEqual(sizes(stopped), [5, null]);
          const afterStop = yield* placement.current;
          assert.isNull(afterStop);
          yield* assertGone(pidOf(ready));

          // Started again, the load logged again: its placement again.
          yield* startFake();
          yield* pushAll(lines);
          const again = yield* placement.current.pipe(when((p) => p !== null && p.buffers.length === 5));
          assert.deepStrictEqual(again?.layers, { offloaded: 49, total: 49 });
          const all = yield* placements;
          assert.deepStrictEqual(Arr.last(all), Option.some(again));
          const running = yield* supervisor.state;
          yield* supervisor.stop;
          yield* assertGone(pidOf(running));
        }),
      ),
  );

  it.effect('Placement: an external server has no placement even if the ring holds an old launch', () =>
    fresh(100)(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        const lines = yield* fixture;
        yield* pushAll(lines);
        const port = yield* freePort;
        const outside = yield* fakeOutside({ port });
        const detected = yield* supervisor.detectExternal(port);
        assert.isTrue(detected);

        const placement = yield* buildPlacement;
        const external = yield* placement.current;
        assert.isNull(external);
        const atConstruction = yield* placements;
        assert.deepStrictEqual(atConstruction, []);

        // A server that writes the whole load, then crashes: no placement once crashed.
        const load = Arr.map(Arr.drop(lines, 1), withoutPrefix);
        assert.isFalse(Arr.some(load, (line) => Str.includes('|')(line)));
        yield* Effect.sync(() => outside.child.kill('SIGKILL'));
        yield* supervisor.recheckExternal.pipe(
          Effect.andThen(supervisor.state),
          when((state) => state.kind === 'idle'),
        );
        yield* startFake({ FAKE_EXIT_LINES: Arr.join(load, '|') });
        const crashed = yield* stateWhen((state) => state.kind === 'crashed');
        assert.deepInclude(crashed, { kind: 'crashed', exitCode: 1 });
        const seen = yield* placements.pipe(
          when((ps) => ps.length >= 2 && Option.exists(Arr.last(ps), (p) => p === null)),
        );
        assert.isNotNull(seen[0]);
        const afterCrash = yield* placement.current;
        assert.isNull(afterCrash);
      }),
    ),
  );

  it.effect('Placement: the launch evicted from the ring keeps the placement of the same server', () =>
    fresh(5)(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor;
        const ring = yield* LogRing;
        const published = yield* Published;
        yield* startFake({ FAKE_LOAD_MS: '1500' });
        // The fake's own lines written: the next ones are the test's.
        yield* ring.since(0).pipe(when(Arr.some((line) => Str.includes('srv  main: cwd ')(line.text))));
        const launchSeq = yield* ring.seq;
        yield* pushAll([
          '[llama-webui] launch: llama-server -m other.gguf',
          'llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 5070 Ti) (0000:01:00.0) - 15683 MiB free',
          'load_tensors: offloaded 10/33 layers to GPU',
          'load_tensors:        CUDA0 model buffer size =  1000.00 MiB',
        ]);
        const placement = yield* buildPlacement;
        const read: ModelPlacement = {
          launchSeq,
          layers: { offloaded: 10, total: 33 },
          buffers: [{ device: 'CUDA0', busId: '0000:01:00.0', modelBytes: 1000 * MiB, kvBytes: 0, computeBytes: 0 }],
        };
        const replayed = yield* placement.current;
        assert.deepStrictEqual(replayed, read);

        // -lv 4 or a sweep: request logs push the launch line out of the ring.
        yield* pushAll(Arr.makeBy(5, (i) => `srv  log_server_r: request ${i}`));
        const held = yield* ring.since(0);
        assert.isFalse(Arr.some(held, (line) => Str.startsWith('[llama-webui] launch:')(line.text)));
        const ready = yield* stateWhen((state) => state.kind === 'ready');
        const whenReady = yield* placement.current;
        assert.deepStrictEqual(whenReady, read);

        // Stopped: forgotten, and only then (not when it turned ready, nor while it stopped).
        yield* supervisor.stop;
        yield* placements.pipe(when((ps) => ps.length >= 1));
        const messages = yield* Ref.get(published);
        const idle = Arr.findFirstIndex(
          messages,
          (message) => message.type === 'server-state' && message.payload.state.kind === 'idle',
        );
        const forgotten = Arr.findFirstIndex(messages, (message) => message.type === 'placement');
        const all = yield* placements;
        assert.deepStrictEqual(all, [null]);
        assert.isTrue(Option.getOrThrow(forgotten) > Option.getOrThrow(idle));
        const afterStop = yield* placement.current;
        assert.isNull(afterStop);
        yield* assertGone(pidOf(ready));
      }),
    ),
  );
});
