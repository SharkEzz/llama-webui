import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { BenchDraft, type BenchSpec, Profile, type Sweep } from '@llama-webui/shared';
import {
  Array as Arr,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Ref,
  Schema,
  String as Str,
} from 'effect';
import { HttpClient, HttpClientRequest, HttpServer } from 'effect/http';
import { Downloads } from '../downloads/Downloads.ts';
import { ApiRoutes, serve } from '../http/HttpLive.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { benchSpec, NO_HARDWARE, sweepSpec } from '../testing/bench.ts';
import { ServerTest } from '../testing/http.ts';
import { ServicesTest, ServicesWithoutBench } from '../testing/services.ts';
import { ofType, openWs, type WsClient } from '../testing/ws.ts';
import { WsHub } from '../ws/WsHub.ts';
import { BenchRunner } from './BenchRunner.ts';
import { BenchRunsRepo } from './BenchRunsRepo.ts';
import { SweepsRepo } from './SweepsRepo.ts';

/** The home of the test (`HOME`): the models folder is the default `~/models` under it. */
class Home extends Context.Service<Home, string>()('@llama-webui/app/server/bench/http.test/Home') {}

/** `HOME` a temporary folder of the test's own; the rest of the configuration as it is. */
const homeConfig = ConfigProvider.layerAdd(
  Effect.map(Home, (home) => ConfigProvider.fromUnknown({ HOME: home })),
  { asPrimary: true },
).pipe(
  Layer.provideMerge(
    Layer.effect(
      Home,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectoryScoped({ prefix: 'lw-bench-http-' });
      }),
    ),
  ),
);

/** The API and `/ws` as the app serves them, on a real server, the services of the app and a home of its own. */
const served = serve(Layer.merge(ApiRoutes, WsHub.route)).pipe(
  Layer.provideMerge(ServicesTest),
  Layer.provideMerge(ServerTest),
  Layer.provideMerge(homeConfig),
  Layer.provideMerge(NodeServices.layer),
);

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The status and (when it is JSON) the value of a raw request; `body` is sent as JSON. */
const send = Effect.fnUntraced(function* (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  const client = yield* HttpClient.HttpClient;
  const base = HttpClientRequest.make(method)(path);
  const text = body === undefined ? undefined : yield* toJson(body);
  const request = text === undefined ? base : HttpClientRequest.bodyText(base, text, 'application/json');
  const res = yield* client.execute(request);
  const answer = yield* res.text;
  const isJson = Option.exists(Option.fromNullishOr(res.headers['content-type']), Str.startsWith('application/json'));
  const json: unknown = isJson && Str.isNonEmpty(answer) ? yield* parseJson(answer) : undefined;
  return { status: res.status, json };
});

/** A JSON reply as the schema reads it: a reply of another shape fails the test. */
const as = <A, I>(schema: Schema.Codec<A, I>, json: unknown) => Schema.decodeUnknownEffect(schema)(json);

/** Runs `effect` and checks what it succeeds with (`message` names the case). */
const equals = <A, E, R>(effect: Effect.Effect<A, E, R>, expected: A, message?: string) =>
  Effect.map(effect, (actual) => assert.deepStrictEqual(actual, expected, message));

/** The `_tag` and `message` of an error reply. */
const Failure = Schema.Struct({ _tag: Schema.String, message: Schema.String });

/** The status, then the `_tag` and `message` of an error reply. */
const failure = Effect.fnUntraced(function* (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  const res = yield* send(method, path, body);
  const { _tag, message } = yield* as(Failure, res.json);
  return { status: res.status, _tag, message };
});

const Runs = Schema.Struct({ runs: Schema.Array(Schema.Struct({ id: Schema.Int })), live: Schema.Null });
const Deleted = Schema.Struct({ deleted: Schema.Int });

/** A `/ws` client of the test's server, closed with the test's scope. */
const wsClient = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const url = `${Str.replace('http', 'ws')(HttpServer.formatAddress(server.address))}/ws`;
  return yield* Effect.acquireRelease(
    Effect.promise(() => openWs(url)),
    (client) => Effect.sync(() => client.socket.close()),
  );
});

/** The next message of `type`, its payload. */
const next = (client: WsClient, type: string) =>
  Effect.promise(() => client.next(ofType(type), 5000)).pipe(
    Effect.map((message) => (message as { readonly payload: unknown }).payload),
  );

/** A run saved with `status` (a one-off run unless `sweepId`), of `spec`. */
const saved = Effect.fnUntraced(function* (
  status: 'running' | 'ok' | 'failed' | 'cancelled' | 'interrupted',
  options: { readonly spec?: BenchSpec; readonly sweepId?: number } = {},
) {
  const runs = yield* BenchRunsRepo;
  const run = yield* runs.create({
    spec: options.spec ?? benchSpec(),
    command: 'llama-bench',
    hardware: NO_HARDWARE,
    status,
    ...(options.sweepId === undefined ? {} : { sweepId: options.sweepId }),
  });
  return run.id;
});

/** The ids of the runs the list answers. */
const listed = Effect.fnUntraced(function* (query: string) {
  const res = yield* send('GET', `/api/bench/runs${query}`);
  assert.strictEqual(res.status, 200, query);
  const { runs } = yield* as(Runs, res.json);
  return Arr.map(runs, (run) => run.id);
});

layer(served, { excludeTestServices: true, buildPerTest: true })('over HTTP', (it) => {
  it.effect('GET /api/bench/runs caps an explicit limit at the sweep default, 10,000 (#37)', () =>
    Effect.gen(function* () {
      const ids = yield* Effect.forEach(Arr.range(1, 3), () => saved('ok'));
      // A limit over the cap is read as the cap, not refused; one under it is kept.
      const all = yield* listed('?limit=20000');
      assert.deepStrictEqual(Arr.sort(all, Order.Number), ids);
      const two = yield* listed('?limit=2');
      assert.strictEqual(two.length, 2);
    }),
  );

  it.effect('the runs query filters by kind, status, model and sweep, and ignores an unknown value', () =>
    Effect.gen(function* () {
      const sweeps = yield* SweepsRepo;
      const sweep = yield* sweeps.create(sweepSpec());
      const bench = yield* saved('ok');
      const server = yield* saved('failed', { spec: benchSpec({ kind: 'server' }) });
      const other = yield* saved('ok', { spec: benchSpec({ modelPath: '/models/other.gguf' }) });
      const item = yield* saved('ok', { sweepId: sweep.id });
      const cases: ReadonlyArray<readonly [string, string, ReadonlyArray<number>]> = [
        ['one-off runs, newest first', '', [other, server, bench]],
        ['kind server', '?kind=server', [server]],
        ['status failed', '?status=failed', [server]],
        ['one model', `?model=${encodeURIComponent('/models/other.gguf')}`, [other]],
        ['every run', '?sweep=all', [item, other, server, bench]],
        ['one sweep', `?sweep=${sweep.id}`, [item]],
        ['an unknown kind, status and sweep', '?kind=nope&status=nope&sweep=nope', [other, server, bench]],
      ];
      for (const [name, query, expected] of cases) {
        const ids = yield* listed(query);
        assert.deepStrictEqual(ids, expected, name);
      }
    }),
  );

  it.effect('DELETE /api/bench/runs is not read as a run id', () =>
    Effect.gen(function* () {
      const id = yield* saved('failed');
      const refused = yield* failure('DELETE', '/api/bench/runs');
      assert.strictEqual(refused.status, 400);
      assert.strictEqual(refused._tag, 'RequestInvalid');
      // The run is still there: nothing went.
      yield* equals(listed(''), [id]);
    }),
  );

  it.effect('deleteFailed refuses anything but failed=1 and publishes the ids it deleted', () =>
    Effect.gen(function* () {
      const ok = yield* saved('ok');
      const failed = yield* saved('failed');
      const cancelled = yield* saved('cancelled');
      const interrupted = yield* saved('interrupted');
      for (const query of ['?failed=0', '?failed=true', '?failed=']) {
        const refused = yield* failure('DELETE', `/api/bench/runs${query}`);
        assert.strictEqual(refused.status, 400, query);
        assert.strictEqual(refused._tag, 'RequestInvalid', query);
      }
      const client = yield* wsClient;
      const res = yield* send('DELETE', '/api/bench/runs?failed=1');
      assert.strictEqual(res.status, 200);
      yield* equals(as(Deleted, res.json), { deleted: 3 });
      const payload = yield* next(client, 'bench-deleted');
      const { ids } = yield* as(Schema.Struct({ ids: Schema.Array(Schema.Int) }), payload);
      assert.deepStrictEqual(Arr.sort(ids, Order.Number), [failed, cancelled, interrupted]);
      yield* equals(listed(''), [ok]);
      // None left: none deleted.
      const again = yield* send('DELETE', '/api/bench/runs?failed=1');
      yield* equals(as(Deleted, again.json), { deleted: 0 });
    }),
  );

  it.effect("a run's delete is a 404 for a missing one, a 409 for a running one, and publishes bench-deleted", () =>
    Effect.gen(function* () {
      const missing = yield* failure('DELETE', '/api/bench/999');
      assert.deepStrictEqual(missing, { status: 404, _tag: 'RunNotFound', message: 'Run not found' });
      const running = yield* saved('running');
      const still = yield* failure('DELETE', `/api/bench/${running}`);
      assert.deepStrictEqual(still, {
        status: 409,
        _tag: 'RunStillRunning',
        message: 'This run is still running: cancel it first',
      });
      const done = yield* saved('ok');
      const client = yield* wsClient;
      const res = yield* send('DELETE', `/api/bench/${done}`);
      assert.strictEqual(res.status, 204);
      yield* equals(next(client, 'bench-deleted'), { ids: [done] });
      yield* equals(listed(''), [running]);
      assert.strictEqual((yield* send('DELETE', `/api/bench/${done}`)).status, 404);
    }),
  );

  it.effect("to-profile names the profile after the model and the run, then (2), and copies the source's env", () =>
    Effect.gen(function* () {
      const home = yield* Home;
      const profiles = yield* ProfilesRepo;
      const source = yield* profiles.create({
        name: 'src',
        model: 'x.gguf',
        args: [],
        env: { CUDA_VISIBLE_DEVICES: '1' },
      });
      const spec = benchSpec({
        modelPath: `${home}/models/org/Model-Q4.gguf`,
        mmprojPath: `${home}/models/org/mmproj.gguf`,
        profileId: source.id,
        params: { ngl: 99, fa: 'on' },
        serverArgs: ['--jinja'],
      });
      const id = yield* saved('ok', { spec });
      const first = yield* send('POST', `/api/bench/${id}/to-profile`);
      assert.strictEqual(first.status, 201);
      const made = yield* as(Profile, first.json);
      assert.strictEqual(made.name, `Model-Q4 — bench #${id}`);
      assert.strictEqual(made.cwd, '~/models');
      assert.strictEqual(made.model, 'org/Model-Q4.gguf');
      assert.strictEqual(made.mmproj, 'org/mmproj.gguf');
      assert.deepStrictEqual(made.args, ['-ngl', '99', '-fa', 'on', '--jinja']);
      assert.deepStrictEqual(made.env, { CUDA_VISIBLE_DEVICES: '1' });
      const second = yield* as(Profile, (yield* send('POST', `/api/bench/${id}/to-profile`)).json);
      assert.strictEqual(second.name, `Model-Q4 — bench #${id} (2)`);
      // No source profile (or one deleted since): no variables.
      const orphan = yield* saved('ok', { spec: benchSpec({ modelPath: '/elsewhere/b.gguf' }) });
      const alone = yield* as(Profile, (yield* send('POST', `/api/bench/${orphan}/to-profile`)).json);
      assert.strictEqual(alone.model, '/elsewhere/b.gguf');
      assert.deepStrictEqual(alone.env, {});
      const running = yield* saved('running');
      const refused = yield* failure('POST', `/api/bench/${running}/to-profile`);
      assert.deepStrictEqual(refused, { status: 409, _tag: 'RunStillRunning', message: 'This run is still running' });
      const missing = yield* failure('POST', '/api/bench/999/to-profile');
      assert.deepStrictEqual(missing, { status: 404, _tag: 'RunNotFound', message: 'Run not found' });
    }),
  );

  it.effect("to-profile adds the sweep context to a sweep item's flags when they set none (#24)", () =>
    Effect.gen(function* () {
      const sweeps = yield* SweepsRepo;
      const sweep = yield* sweeps.create(sweepSpec({ preset: 'agent' }));
      yield* sweeps.setStatus(sweep.id, 'done');
      const bare = yield* saved('ok', { spec: benchSpec({ kind: 'server' }), sweepId: sweep.id });
      const sized = yield* saved('ok', {
        spec: benchSpec({ kind: 'server', serverArgs: ['-c', '4096'] }),
        sweepId: sweep.id,
      });
      const argsOf = Effect.fnUntraced(function* (id: number) {
        const made = yield* as(Profile, (yield* send('POST', `/api/bench/${id}/to-profile`)).json);
        return made.args;
      });
      // The context the sweep planned for (the agent preset's 16k), not the model's full one.
      yield* equals(argsOf(bare), ['-c', '16384']);
      yield* equals(argsOf(sized), ['-c', '4096']);
      // A one-off run: its flags as they are.
      const oneOff = yield* saved('ok');
      yield* equals(argsOf(oneOff), []);
    }),
  );

  it.effect("from-profile splits the profile's args and resolves its files against its cwd", () =>
    Effect.gen(function* () {
      const home = yield* Home;
      const profiles = yield* ProfilesRepo;
      const profile = yield* profiles.create({
        name: 'p',
        cwd: '~/models/org',
        model: 'a.gguf',
        mmproj: '/abs/mm.gguf',
        args: ['-ngl', '99', '--jinja', '-fa', 'on', '--temp', '0.7'],
        env: {},
      });
      const res = yield* send('GET', `/api/bench/from-profile/${profile.id}`);
      assert.strictEqual(res.status, 200);
      const draft = yield* as(BenchDraft, res.json);
      assert.deepStrictEqual(draft, {
        modelPath: `${home}/models/org/a.gguf`,
        mmprojPath: '/abs/mm.gguf',
        profileId: profile.id,
        params: { ngl: 99, fa: 'on' },
        serverArgs: ['--jinja', '--temp', '0.7'],
      });
      const missing = yield* failure('GET', '/api/bench/from-profile/999');
      assert.strictEqual(missing.status, 404);
      assert.strictEqual(missing._tag, 'ProfileNotFound');
    }),
  );

  it.effect("a sweep's delete publishes its run ids, then the sweep, and a running one is a 409", () =>
    Effect.gen(function* () {
      const sweeps = yield* SweepsRepo;
      const runs = yield* BenchRunsRepo;
      const running = yield* sweeps.create(sweepSpec());
      const still = yield* failure('DELETE', `/api/sweeps/${running.id}`);
      assert.deepStrictEqual(still, {
        status: 409,
        _tag: 'SweepStillRunning',
        message: 'This sweep is still running: cancel it first',
      });
      const done = yield* sweeps.create(sweepSpec());
      yield* sweeps.setStatus(done.id, 'done');
      const items = yield* runs.enqueue(done.id, [
        { spec: benchSpec({ kind: 'server' }), label: 'a', fit: 'fits' },
        { spec: benchSpec({ kind: 'server' }), label: 'b', fit: 'tight' },
      ]);
      const client = yield* wsClient;
      const res = yield* send('DELETE', `/api/sweeps/${done.id}`);
      assert.strictEqual(res.status, 204);
      const deleted = yield* next(client, 'bench-deleted');
      assert.deepStrictEqual(deleted, { ids: Arr.map(items, (item) => item.id) });
      yield* equals(next(client, 'sweep-deleted'), { id: done.id });
      yield* equals(Effect.map(sweeps.get(done.id), Option.isNone), true);
      const missing = yield* failure('DELETE', `/api/sweeps/${done.id}`);
      assert.deepStrictEqual(missing, { status: 404, _tag: 'SweepNotFound', message: 'Sweep not found' });
      // A sweep of no item: an empty `bench-deleted` all the same.
      const empty = yield* sweeps.create(sweepSpec());
      yield* sweeps.setStatus(empty.id, 'cancelled');
      assert.strictEqual((yield* send('DELETE', `/api/sweeps/${empty.id}`)).status, 204);
      yield* equals(next(client, 'bench-deleted'), { ids: [] });
      yield* equals(next(client, 'sweep-deleted'), { id: empty.id });
    }),
  );
});

/** What the recording runner was asked: each resume and validation, with its options. */
class Asked extends Context.Service<Asked, Ref.Ref<ReadonlyArray<unknown>>>()(
  '@llama-webui/app/server/bench/http.test/Asked',
) {}

/** A runner that records its resumes and validations and answers the sweep as it is stored. */
const RecordingRunner = Layer.effect(
  BenchRunner,
  Effect.gen(function* () {
    const asked = yield* Asked;
    const sweeps = yield* SweepsRepo;
    const unused = Effect.die('not used by the test');
    const stored = (id: number) =>
      sweeps.get(id).pipe(
        Effect.flatMap((sweep) => Effect.fromOption(sweep)),
        Effect.orDie,
      );
    const record = (entry: unknown, id: number): Effect.Effect<Sweep> =>
      Ref.update(asked, Arr.append(entry)).pipe(Effect.andThen(stored(id)));
    return BenchRunner.of({
      busy: Effect.succeed(false),
      live: Effect.succeed(null),
      sweepLive: Effect.succeed(null),
      files: Effect.succeed([]),
      start: () => unused,
      startSweep: () => unused,
      resume: (id, options) => record({ resume: options }, id),
      validate: (id, options) => record({ validate: options }, id),
      cancel: () => unused,
      cancelSweep: () => unused,
    });
  }),
).pipe(Layer.provideMerge(Layer.effect(Asked, Ref.make<ReadonlyArray<unknown>>([]))));

/** The routes on the services of the app with the recording runner in place of the real one. */
const recorded = serve(ApiRoutes).pipe(
  Layer.provideMerge(
    Downloads.layerWith({
      freeBytes: () => Effect.succeed(null),
      retryDelays: [],
      stall: '5 seconds',
      liveEvery: '0 millis',
    }),
  ),
  Layer.provideMerge(RecordingRunner),
  Layer.provideMerge(ServicesWithoutBench),
  Layer.provideMerge(ServerTest),
  Layer.provideMerge(homeConfig),
  Layer.provideMerge(NodeServices.layer),
);

/** A sweep stored `interrupted`, its id. */
const interruptedSweep = Effect.gen(function* () {
  const sweeps = yield* SweepsRepo;
  const sweep = yield* sweeps.create(sweepSpec());
  yield* sweeps.setStatus(sweep.id, 'interrupted');
  return sweep.id;
});

layer(recorded, { excludeTestServices: true, buildPerTest: true })('the runner asked', (it) => {
  it.effect('resume reads stopServer only when it is true', () =>
    Effect.gen(function* () {
      const id = yield* interruptedSweep;
      const bodies: ReadonlyArray<readonly [string, unknown]> = [
        ['none', {}],
        ['the string true', { stopServer: 'true' }],
        ['1', { stopServer: 1 }],
        ['false', { stopServer: false }],
        ['true', { stopServer: true }],
      ];
      for (const [name, body] of bodies) {
        const res = yield* send('POST', `/api/sweeps/${id}/resume`, body);
        assert.strictEqual(res.status, 202, name);
      }
      const asked = yield* Asked;
      yield* equals(Ref.get(asked), [
        { resume: { stopServer: false } },
        { resume: { stopServer: false } },
        { resume: { stopServer: false } },
        { resume: { stopServer: false } },
        { resume: { stopServer: true } },
      ]);
    }),
  );

  it.effect('validate refuses n out of 1–5 and an unknown key', () =>
    Effect.gen(function* () {
      const id = yield* interruptedSweep;
      const refusals: ReadonlyArray<readonly [string, unknown]> = [
        ['n 0', { n: 0 }],
        ['n 6', { n: 6 }],
        ['n 2.5', { n: 2.5 }],
        ['n a string', { n: '2' }],
        ['an unknown key', { nope: 1 }],
        ['stopServer a string', { stopServer: 'yes' }],
      ];
      for (const [name, body] of refusals) {
        const refused = yield* failure('POST', `/api/sweeps/${id}/validate`, body);
        assert.strictEqual(refused.status, 400, name);
        assert.strictEqual(refused._tag, 'RequestInvalid', name);
      }
      const accepted: ReadonlyArray<readonly [string, unknown]> = [
        ['none', {}],
        ['n 1', { n: 1 }],
        ['n 5 and stopServer', { n: 5, stopServer: true }],
      ];
      for (const [name, body] of accepted) {
        const res = yield* send('POST', `/api/sweeps/${id}/validate`, body);
        assert.strictEqual(res.status, 202, name);
      }
      const asked = yield* Asked;
      yield* equals(Ref.get(asked), [
        { validate: { n: 3, stopServer: false } },
        { validate: { n: 1, stopServer: false } },
        { validate: { n: 5, stopServer: true } },
      ]);
    }),
  );
});
