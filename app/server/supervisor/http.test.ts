import { assert, layer } from '@effect/vitest';
import { type ProfileInput, type ServerState, ServerView } from '@llama-webui/shared';
import { Effect, Exit, Layer, Option, Schedule, Schema, Scope, String as Str } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { AppInfo } from '../config/AppInfo.ts';
import { ApiRoutes, serve } from '../http/HttpLive.ts';
import { isAlive } from '../llama/procScan.ts';
import { LogRing } from '../logs/LogRing.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { ServerTest } from '../testing/http.ts';
import { FAKE, fakeOutside, freePort, httpStub } from '../testing/llama.ts';
import { ServicesTest } from '../testing/services.ts';
import { Supervisor } from './Supervisor.ts';

/** The API as the app serves it, on a real server, with the services it uses; the settings name the fake. */
const Served = serve(ApiRoutes).pipe(
  Layer.provideMerge(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const settings = yield* SettingsRepo;
        yield* settings.patch({ binary: FAKE });
      }),
    ).pipe(Layer.provideMerge(ServicesTest)),
  ),
  Layer.provideMerge(ServerTest),
);

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The status and (when it is JSON) the value of a raw reply. */
const send = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.make(method)(path);
    const request = body === undefined ? base : HttpClientRequest.bodyText(base, body, 'application/json');
    const res = yield* client.execute(request);
    const text = yield* res.text;
    const isJson = Option.exists(Option.fromNullishOr(res.headers['content-type']), Str.startsWith('application/json'));
    const json: unknown = isJson && Str.isNonEmpty(text) ? yield* parseJson(text) : undefined;
    return { status: res.status, text, json };
  });

/** A launch of `profileId` through `/api/server/<what>`: its status and its view. */
const launch = (what: 'start' | 'switch', profileId: number) =>
  Effect.gen(function* () {
    const reply = yield* send('POST', `/api/server/${what}`, `{"profileId":${profileId}}`);
    return { status: reply.status, json: reply.json };
  });

const viewOf = (json: unknown) => Schema.decodeUnknownEffect(ServerView)(json);

/** A profile of the fake on a free port (or `port`), its `env` holding the `FAKE_*` variables. */
const profileOf = (name: string, more: Partial<ProfileInput> = {}) =>
  Effect.gen(function* () {
    const repo = yield* ProfilesRepo;
    const port = more.port ?? (yield* freePort);
    return yield* repo.create({ name, model: 'm.gguf', args: [], env: {}, ...more, port });
  });

/** The state, once `ok` holds (looked at every 10 ms, for 5 s at most). */
const stateWhen = (ok: (state: ServerState) => boolean) =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor;
    return yield* supervisor.state.pipe(
      Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: ok }),
      Effect.timeout('5 seconds'),
    );
  });

const kindIs = (kind: ServerState['kind']) => (state: ServerState) => state.kind === kind;

const pidOf = (state: ServerState): number => ('pid' in state && state.pid !== null ? state.pid : -1);

const defaultProfile = Effect.gen(function* () {
  const settings = yield* SettingsRepo;
  const current = yield* settings.get;
  return current.defaultProfileId;
});

const assertGone = (pid: number) => Effect.map(isAlive(pid), (alive) => assert.isTrue(pid > 0 && !alive, `${pid}`));

layer(Served, { excludeTestServices: true, buildPerTest: true })('ServerApi over HTTP', (it) => {
  it.effect('start answers 202 with the view, sets the default profile, and state then says ready', () =>
    Effect.gen(function* () {
      const profile = yield* profileOf('first');
      const started = yield* launch('start', profile.id);
      assert.strictEqual(started.status, 202);
      const view = yield* viewOf(started.json);
      assert.deepInclude(view.state, { kind: 'starting', profile: 'first', profileId: profile.id, port: profile.port });
      assert.strictEqual(view.profileId, profile.id);
      assert.isTrue(Str.includes(`--port ${profile.port}`)(view.command ?? ''), view.command ?? '');
      const remembered = yield* defaultProfile;
      assert.strictEqual(remembered, profile.id);
      yield* stateWhen(kindIs('ready'));
      const state = yield* send('GET', '/api/server/state');
      assert.strictEqual(state.status, 200);
      const now = yield* viewOf(state.json);
      assert.deepInclude(now.state, { kind: 'ready', profileId: profile.id });
    }),
  );

  it.effect(
    'start of a profile that does not exist is a 404 ProfileNotFound; a profileId that is "1", true or missing is a 400 RequestInvalid',
    () =>
      Effect.gen(function* () {
        const missing = yield* launch('start', 999);
        assert.deepStrictEqual(missing, {
          status: 404,
          json: { _tag: 'ProfileNotFound', message: 'Profile not found' },
        });
        for (const body of ['{"profileId":"1"}', '{"profileId":true}', '{}']) {
          const refused = yield* send('POST', '/api/server/start', body);
          assert.strictEqual(refused.status, 400, body);
          assert.deepInclude(refused.json, { _tag: 'RequestInvalid' });
        }
      }),
  );

  it.effect(
    'a start that cannot launch is still a 202: crashed with its message, the profile remembered, restart takes it',
    () =>
      Effect.gen(function* () {
        const profile = yield* profileOf('nowhere', { cwd: '/no/such/folder' });
        const started = yield* launch('start', profile.id);
        assert.strictEqual(started.status, 202);
        const view = yield* viewOf(started.json);
        assert.deepInclude(view.state, { kind: 'crashed', message: 'directory not found: /no/such/folder' });
        assert.strictEqual(view.profileId, profile.id);
        const remembered = yield* defaultProfile;
        assert.strictEqual(remembered, profile.id);
        const repo = yield* ProfilesRepo;
        yield* repo.update({
          id: profile.id,
          input: { name: 'nowhere', model: 'm.gguf', args: [], env: {}, port: profile.port ?? 0 },
        });
        const restarted = yield* send('POST', '/api/server/restart');
        assert.strictEqual(restarted.status, 202);
        const after = yield* viewOf(restarted.json);
        assert.deepInclude(after.state, { kind: 'starting', profileId: profile.id });
      }),
  );

  it.effect(
    'start while a server runs is a 409 ServerAlreadyRunning; on a taken port a 409 PortInUse with by and pid',
    () =>
      Effect.gen(function* () {
        const first = yield* profileOf('first');
        const second = yield* profileOf('second');
        yield* launch('start', first.id);
        const again = yield* launch('start', second.id);
        assert.deepStrictEqual(again, {
          status: 409,
          json: { _tag: 'ServerAlreadyRunning', message: 'a server is already running' },
        });
        const stopped = yield* send('POST', '/api/server/stop');
        assert.strictEqual(stopped.status, 200);

        const port = yield* freePort;
        yield* fakeOutside({ port });
        const taken = yield* profileOf('taken', { port });
        const refused = yield* launch('start', taken.id);
        // The outside fake runs as `node`: /proc names no llama-server on the port, its pid is unknown.
        assert.deepStrictEqual(refused, {
          status: 409,
          json: {
            _tag: 'PortInUse',
            message: 'port in use by an external server (PID unknown)',
            port,
            by: 'llama-server',
            pid: null,
          },
        });
      }),
  );

  it.effect('switch stops the running profile and starts the other, which becomes the default', () =>
    Effect.gen(function* () {
      const first = yield* profileOf('first');
      const second = yield* profileOf('second');
      yield* launch('start', first.id);
      const running = yield* stateWhen(kindIs('ready'));
      const switched = yield* launch('switch', second.id);
      assert.strictEqual(switched.status, 202);
      const view = yield* viewOf(switched.json);
      assert.deepInclude(view.state, { kind: 'starting', profile: 'second', profileId: second.id });
      yield* assertGone(pidOf(running));
      const remembered = yield* defaultProfile;
      assert.strictEqual(remembered, second.id);
    }),
  );

  it.effect(
    'restart without any launch is a 409 NoProfileToRestart; after a stop it relaunches the last profile with its edits; of a deleted profile it is a 404; it leaves the default profile alone',
    () =>
      Effect.gen(function* () {
        const none = yield* send('POST', '/api/server/restart');
        assert.deepStrictEqual(none, {
          status: 409,
          text: none.text,
          json: { _tag: 'NoProfileToRestart', message: 'No profile to restart' },
        });

        const profile = yield* profileOf('edited');
        yield* launch('start', profile.id);
        yield* send('POST', '/api/server/stop');
        const settings = yield* SettingsRepo;
        yield* settings.patch({ defaultProfileId: null });
        const repo = yield* ProfilesRepo;
        yield* repo.update({
          id: profile.id,
          input: { name: 'edited', model: 'm.gguf', args: ['-c', '2048'], env: {}, port: profile.port ?? 0 },
        });
        const restarted = yield* send('POST', '/api/server/restart');
        assert.strictEqual(restarted.status, 202);
        const view = yield* viewOf(restarted.json);
        assert.deepInclude(view.state, { kind: 'starting', profileId: profile.id });
        assert.isTrue(Str.includes('-c 2048')(view.command ?? ''), view.command ?? '');
        const remembered = yield* defaultProfile;
        assert.isNull(remembered);

        yield* send('POST', '/api/server/stop');
        yield* repo.remove(profile.id);
        const deleted = yield* send('POST', '/api/server/restart');
        assert.deepStrictEqual(deleted.json, { _tag: 'ProfileNotFound', message: 'Profile not found' });
        assert.strictEqual(deleted.status, 404);
      }),
  );

  it.effect('stop answers 200 once llama-server exited, and keeps the command and the profile of the view', () =>
    Effect.gen(function* () {
      const profile = yield* profileOf('stopped');
      const started = yield* launch('start', profile.id);
      const before = yield* viewOf(started.json);
      const running = yield* stateWhen(kindIs('ready'));
      const stopped = yield* send('POST', '/api/server/stop');
      assert.strictEqual(stopped.status, 200);
      const view = yield* viewOf(stopped.json);
      assert.deepStrictEqual(view, { state: { kind: 'idle' }, command: before.command, profileId: profile.id });
      yield* assertGone(pidOf(running));
    }),
  );

  it.effect(
    "props: llama-server's JSON as it is when ready; a 409 ServerNotReady when idle or starting; a 502 for an error status, for a body that is not JSON (#37) and for no answer",
    () =>
      Effect.gen(function* () {
        const notReady = { status: 409, json: { _tag: 'ServerNotReady', message: 'Server not ready' } };
        const idle = yield* send('GET', '/api/server/props');
        assert.deepStrictEqual({ status: idle.status, json: idle.json }, notReady);

        const slow = yield* profileOf('slow', { env: { FAKE_LOAD_MS: '2000' } });
        yield* launch('start', slow.id);
        const starting = yield* send('GET', '/api/server/props');
        assert.deepStrictEqual({ status: starting.status, json: starting.json }, notReady);
        yield* send('POST', '/api/server/stop');

        const profile = yield* profileOf('ready');
        yield* launch('start', profile.id);
        yield* stateWhen(kindIs('ready'));
        const ready = yield* send('GET', '/api/server/props');
        assert.strictEqual(ready.status, 200);
        assert.deepInclude(ready.json, { total_slots: 1 });
        yield* send('POST', '/api/server/stop');

        // A server started by hand, whose /props answers badly, then not at all.
        let mode: 'status' | 'text' = 'status';
        const stubScope = yield* Scope.make();
        const stub = yield* httpStub((req, res) => {
          if (req.url === '/health') res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
          else if (mode === 'status') res.writeHead(500).end('{}');
          else res.writeHead(200, { 'content-type': 'application/json' }).end('<html>');
        }).pipe(Scope.provide(stubScope));
        const supervisor = yield* Supervisor;
        const detected = yield* supervisor.detectExternal(stub.port);
        assert.isTrue(detected);
        const status = yield* send('GET', '/api/server/props');
        assert.deepStrictEqual(status.json, { _tag: 'PropsUnavailable', message: 'llama-server /props: HTTP 500' });
        assert.strictEqual(status.status, 502);
        mode = 'text';
        const text = yield* send('GET', '/api/server/props');
        assert.deepStrictEqual(text.json, {
          _tag: 'PropsUnavailable',
          message: 'llama-server /props: the reply is not JSON',
        });
        assert.strictEqual(text.status, 502);
        yield* Scope.close(stubScope, Exit.void);
        const silent = yield* send('GET', '/api/server/props');
        assert.deepStrictEqual(silent.json, {
          _tag: 'PropsUnavailable',
          message: 'llama-server is not responding on /props',
        });
        assert.strictEqual(silent.status, 502);
      }),
  );

  it.effect('GET /api/state: the view, the next log number and the boot id', () =>
    Effect.gen(function* () {
      const ring = yield* LogRing;
      yield* ring.push('a line');
      const { bootId } = yield* AppInfo;
      const supervisor = yield* Supervisor;
      const view = yield* supervisor.view;
      const snapshot = yield* send('GET', '/api/state');
      assert.strictEqual(snapshot.status, 200);
      assert.deepStrictEqual(snapshot.json, { server: view, logSeq: 1, bootId });
    }),
  );
});
