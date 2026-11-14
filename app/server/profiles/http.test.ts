import { assert, describe, layer } from '@effect/vitest';
import { Api, Profile, type ProfileInput, ProfilesFile, type ServerState } from '@llama-webui/shared';
import { Array as Arr, Effect, Fiber, Layer, Option, Schedule, Schema, String as Str } from 'effect';
import { HttpClient, HttpClientRequest, HttpServer } from 'effect/http';
import { HttpApiTest } from 'effect/http-api';
import { SqlClient } from 'effect/sql';
import { ApiRoutes, serve } from '../http/HttpLive.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { ServerTest } from '../testing/http.ts';
import { FAKE, freePort } from '../testing/llama.ts';
import { ServicesTest } from '../testing/services.ts';
import { ProfilesHandlers } from './http.ts';
import { ProfilesRepo } from './ProfilesRepo.ts';

const makeClient = HttpApiTest.groups(Api, ['profiles']);

/** The handlers on the services of the app, for the typed client. */
const Handlers = Layer.mergeAll(ProfilesHandlers.pipe(Layer.provideMerge(ServicesTest)), HttpServer.layerServices);

/** The API as the app serves it, on a real server, with the services it uses for what a test checks behind it. */
const Served = serve(ApiRoutes).pipe(Layer.provideMerge(ServicesTest), Layer.provideMerge(ServerTest));

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The status, the headers, the text and (when it is JSON) the value of a raw reply. */
const send = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.make(method)(path);
    const request = body === undefined ? base : HttpClientRequest.bodyText(base, body, 'application/json');
    const res = yield* client.execute(request);
    const text = yield* res.text;
    const isJson = Option.exists(Option.fromNullishOr(res.headers['content-type']), Str.startsWith('application/json'));
    const json: unknown = isJson && Str.isNonEmpty(text) ? yield* parseJson(text) : undefined;
    return { status: res.status, headers: res.headers, text, json };
  });

/** A JSON reply as the schema reads it: a reply of another shape fails the test. */
const as = <A, I>(schema: Schema.Codec<A, I>, json: unknown) => Schema.decodeUnknownEffect(schema)(json);

/** The body of a 400 `RequestInvalid`. */
const Refused = Schema.TaggedStruct('RequestInvalid', {
  message: Schema.String,
  issues: Schema.Array(Schema.Struct({ path: Schema.Array(Schema.String), message: Schema.String })),
});

const notFound = { _tag: 'ProfileNotFound', message: 'Profile not found' };

/** Waits until the supervisor is in `kind` (looked at every 10 ms, for 5 s at most). */
const stateWhen = (supervisor: Supervisor['Service'], kind: ServerState['kind']) =>
  supervisor.state.pipe(
    Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (state) => state.kind === kind }),
    Effect.timeout('5 seconds'),
  );

/** The smallest valid input. */
const input = (name: string, more: Partial<ProfileInput> = {}): ProfileInput => ({
  name,
  model: '/models/m.gguf',
  args: [],
  env: {},
  ...more,
});

describe('ProfilesApi', () => {
  layer(Served)('over HTTP', (it) => {
    it.effect('create answers 201 with the stored profile, a taken name 409 ProfileNameTaken', () =>
      Effect.gen(function* () {
        const created = yield* send('POST', '/api/profiles', '{"name":"Created","model":"/m.gguf","port":8081}');
        assert.strictEqual(created.status, 201);
        const profile = yield* as(Profile, created.json);
        assert.deepStrictEqual(profile, {
          id: profile.id,
          name: 'Created',
          model: '/m.gguf',
          port: 8081,
          args: [],
          env: {},
          source: 'ui',
          createdAt: profile.createdAt,
          updatedAt: profile.createdAt,
        });
        const taken = yield* send('POST', '/api/profiles', '{"name":"Created","model":"m"}');
        assert.strictEqual(taken.status, 409);
        assert.deepStrictEqual(taken.json, {
          _tag: 'ProfileNameTaken',
          message: 'A profile named “Created” already exists',
        });
      }),
    );

    it.effect('an invalid profile is a 400 RequestInvalid naming each field, on create and on update', () =>
      Effect.gen(function* () {
        const bad = yield* send(
          'POST',
          '/api/profiles',
          '{"name":"","model":"m","port":0,"args":["--port","1"],"id":3}',
        );
        assert.strictEqual(bad.status, 400);
        // Effect reports an unknown key before the fields (zod reported it after them).
        const refused = yield* as(Refused, bad.json);
        assert.deepStrictEqual(refused, {
          _tag: 'RequestInvalid',
          message: 'Invalid data: unknown key (id)',
          issues: [
            { path: ['id'], message: 'unknown key' },
            { path: ['name'], message: 'cannot be empty' },
            { path: ['port'], message: 'port between 1 and 65535' },
            { path: ['args', '0'], message: '--port is managed by llama-webui (use the profile fields)' },
          ],
        });

        // A stored profile is not an input: its id, source and dates are unknown keys.
        const repo = yield* ProfilesRepo;
        const stored = yield* repo.create(input('Stored'));
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(Profile))(stored);
        const full = yield* send('PUT', `/api/profiles/${stored.id}`, body);
        assert.strictEqual(full.status, 400);
        const fullRefused = yield* as(Refused, full.json);
        assert.deepStrictEqual(fullRefused.issues, [
          { path: ['id'], message: 'unknown key' },
          { path: ['source'], message: 'unknown key' },
          { path: ['createdAt'], message: 'unknown key' },
          { path: ['updatedAt'], message: 'unknown key' },
        ]);
      }),
    );

    it.effect(
      'update of a profile that is not there is a 404 ProfileNotFound after the body, an id that is not a number the unknown route',
      () =>
        Effect.gen(function* () {
          const missing = yield* send('PUT', '/api/profiles/999', '{"name":"x","model":"m"}');
          assert.strictEqual(missing.status, 404);
          assert.deepStrictEqual(missing.json, notFound);
          // The body is decoded first: an invalid one is a 400 even when the profile is not there.
          const invalid = yield* send('PUT', '/api/profiles/999', '{"name":"","model":"m"}');
          assert.strictEqual(invalid.status, 400);
          for (const path of ['/api/profiles/abc', '/api/profiles/0', '/api/profiles/1.5']) {
            const word = yield* send('GET', path);
            assert.strictEqual(word.status, 404, path);
            assert.deepStrictEqual(word.json, { _tag: 'RouteNotFound', message: 'Unknown route' }, path);
          }
        }),
    );

    it.effect('remove answers 204 with no body and clears the default profile setting', () =>
      Effect.gen(function* () {
        const repo = yield* ProfilesRepo;
        const settings = yield* SettingsRepo;
        const kept = yield* repo.create(input('Kept default'));
        const other = yield* repo.create(input('Other'));
        yield* settings.patch({ defaultProfileId: kept.id });
        const removed = yield* send('DELETE', `/api/profiles/${other.id}`);
        assert.deepStrictEqual([removed.status, removed.text, removed.headers['content-type']], [204, '', undefined]);
        const still = yield* settings.get;
        assert.strictEqual(still.defaultProfileId, kept.id);
        const removedDefault = yield* send('DELETE', `/api/profiles/${kept.id}`);
        assert.strictEqual(removedDefault.status, 204);
        const cleared = yield* settings.get;
        assert.isNull(cleared.defaultProfileId);
        const again = yield* send('DELETE', `/api/profiles/${kept.id}`);
        assert.deepStrictEqual([again.status, again.json], [404, notFound]);
      }),
    );

    it.effect('both exports are files: indented, a trailing newline, a percent-encoded name', () =>
      Effect.gen(function* () {
        const repo = yield* ProfilesRepo;
        const name = 'né / "x" 🦙';
        const profile = yield* repo.create(input(name, { port: 8090, args: ['-c', '4096'], env: { A: '1' } }));
        const one = yield* send('GET', `/api/profiles/${profile.id}/export`);
        assert.strictEqual(one.status, 200);
        assert.strictEqual(one.headers['content-type'], 'application/json');
        assert.strictEqual(
          one.headers['content-disposition'],
          `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.json`)}`,
        );
        // The fields of the input only, in the order of the schema, indented by two spaces.
        assert.strictEqual(
          one.text,
          Arr.join(
            [
              '{',
              '  "name": "né / \\"x\\" 🦙",',
              '  "model": "/models/m.gguf",',
              '  "port": 8090,',
              '  "args": [',
              '    "-c",',
              '    "4096"',
              '  ],',
              '  "env": {',
              '    "A": "1"',
              '  }',
              '}',
              '',
            ],
            '\n',
          ),
        );

        const all = yield* send('GET', '/api/profiles/export');
        assert.strictEqual(all.status, 200);
        assert.strictEqual(all.headers['content-type'], 'application/json');
        assert.strictEqual(
          all.headers['content-disposition'],
          "attachment; filename*=UTF-8''llama-webui-profiles.json",
        );
        assert.isTrue(Str.startsWith('{\n  "profiles": [\n    {\n      "name": ')(all.text), all.text);
        assert.isTrue(Str.endsWith(']\n}\n')(all.text), all.text);
        const file = yield* as(ProfilesFile, all.json);
        const list = yield* repo.list;
        const inputs = Arr.map(list, ({ id: _i, source: _s, createdAt: _c, updatedAt: _u, ...rest }) => rest);
        assert.deepStrictEqual(file, { profiles: inputs });

        const missing = yield* send('GET', '/api/profiles/999/export');
        assert.deepStrictEqual([missing.status, missing.json], [404, notFound]);
      }),
    );

    it.effect('an import of a body that holds no profile is one skip; an empty body is not JSON', () =>
      Effect.gen(function* () {
        const none = { imported: [], skipped: [{ name: '(file)', reason: 'no profile found in this JSON' }] };
        for (const body of ['null', '3', '"x"', '{}']) {
          const reply = yield* send('POST', '/api/profiles/import', body);
          assert.deepStrictEqual([reply.status, reply.json], [200, none], body);
        }
        const empty = yield* send('POST', '/api/profiles/import');
        assert.strictEqual(empty.status, 400);
        assert.deepStrictEqual(empty.json, {
          _tag: 'RequestInvalid',
          message: 'Invalid data: Expected JSON value',
          issues: [{ path: [], message: 'Expected JSON value' }],
        });
        const malformed = yield* send('POST', '/api/profiles/import', '{');
        assert.strictEqual(malformed.status, 400);
        const malformedRefused = yield* as(Refused, malformed.json);
        assert.strictEqual(malformedRefused.message, 'Invalid data: Expected a valid JSON body');
      }),
    );

    it.effect('a stored profile the input rules now refuse is still listed, read, exported and copied', () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // As the Nitro server could have stored it before `--metrics` became a reserved flag.
        yield* sql`INSERT INTO profiles (name, model_path, args_json, env_json, source, created_at, updated_at)
                   VALUES ('Old row', '/m.gguf', '["--metrics","-c","1"]', '{}', 'llama-tui', 1, 1)`;
        const list = yield* send('GET', '/api/profiles');
        assert.strictEqual(list.status, 200);
        const profiles = yield* as(Schema.Array(Schema.Struct({ id: Schema.Int, name: Schema.String })), list.json);
        const old = Arr.findFirst(profiles, (p) => p.name === 'Old row');
        assert.isTrue(Option.isSome(old));
        const id = Option.getOrThrow(old).id;
        const got = yield* send('GET', `/api/profiles/${id}`);
        assert.strictEqual(got.status, 200);
        const one = yield* send('GET', `/api/profiles/${id}/export`);
        assert.strictEqual(one.status, 200);
        const all = yield* send('GET', '/api/profiles/export');
        assert.strictEqual(all.status, 200);
        const copy = yield* send('POST', `/api/profiles/${id}/duplicate`);
        assert.strictEqual(copy.status, 201);
        assert.deepStrictEqual((yield* as(Profile, copy.json)).args, ['--metrics', '-c', '1']);
        // Saving it again is refused until the reserved flag is removed: the form shows where.
        const saved = yield* send(
          'PUT',
          `/api/profiles/${id}`,
          '{"name":"Old row","model":"/m.gguf","args":["--metrics"]}',
        );
        assert.strictEqual(saved.status, 400);
      }),
    );
  });

  // On the real clock: the supervisor polls `/health` and the test waits on its states.
  layer(Served, { excludeTestServices: true })('over HTTP, with llama-server', (it) => {
    it.effect(
      'deleting the profile of the running server is a 409 ProfileRunning while starting, ready or stopping; after the stop it is deleted',
      () =>
        Effect.gen(function* () {
          const repo = yield* ProfilesRepo;
          const settings = yield* SettingsRepo;
          const supervisor = yield* Supervisor;
          yield* settings.patch({ binary: FAKE });
          const port = yield* freePort;
          // Slow to load, and deaf to SIGTERM: each state lasts long enough to be tried.
          const profile = yield* repo.create(
            input('Running', { port, env: { FAKE_LOAD_MS: '300', FAKE_IGNORE_TERM: '1' } }),
          );
          const running = {
            _tag: 'ProfileRunning',
            message: 'This profile belongs to the running server: stop it first',
          };
          const refused = (kind: ServerState['kind']) =>
            Effect.gen(function* () {
              const state = yield* supervisor.state;
              const reply = yield* send('DELETE', `/api/profiles/${profile.id}`);
              assert.strictEqual(state.kind, kind);
              assert.deepStrictEqual([reply.status, reply.json], [409, running], kind);
            });
          const started = yield* send('POST', '/api/server/start', `{"profileId":${profile.id}}`);
          assert.strictEqual(started.status, 202);
          yield* refused('starting');
          yield* stateWhen(supervisor, 'ready');
          yield* refused('ready');
          const stopping = yield* Effect.forkChild(send('POST', '/api/server/stop'));
          yield* stateWhen(supervisor, 'stopping');
          yield* refused('stopping');
          yield* Fiber.join(stopping);
          const removed = yield* send('DELETE', `/api/profiles/${profile.id}`);
          assert.strictEqual(removed.status, 204);
          const gone = yield* send('GET', `/api/profiles/${profile.id}`);
          assert.strictEqual(gone.status, 404);
        }),
    );
  });

  layer(Handlers)('typed client', (it) => {
    it.effect('duplicate answers the copy', () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const source = yield* client.profiles.create({ payload: input('Dup', { port: 8085 }) });
        const copy = yield* client.profiles.duplicate({ params: { id: source.id } });
        assert.strictEqual(copy.name, 'Dup (copy)');
        assert.strictEqual(copy.port, 8085);
        assert.notStrictEqual(copy.id, source.id);
        const missing = yield* Effect.flip(client.profiles.duplicate({ params: { id: 999 } }));
        assert.strictEqual(missing._tag, 'ProfileNotFound');
      }),
    );

    it.effect('import explains every skip and creates the rest, whatever the body', () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        yield* client.profiles.create({ payload: input('A') });
        const result = yield* client.profiles.importMany({
          payload: {
            profiles: [
              { name: 'B', model: '/models/b.gguf' },
              { name: 'bad' },
              { name: 'B', model: 'x' },
              { name: 'A', model: 'x' },
            ],
          },
        });
        assert.deepStrictEqual(
          Arr.map(result.imported, (profile) => [profile.name, profile.source]),
          [['B', 'import']],
        );
        assert.deepStrictEqual(result.skipped, [
          { name: 'bad', reason: 'required (model)' },
          { name: 'B', reason: 'duplicate name in the file' },
          { name: 'A', reason: 'already exists' },
        ]);
        const list = yield* client.profiles.list();
        assert.includeMembers(
          Arr.map(list, (profile) => profile.name),
          ['A', 'B'],
        );
        const [b] = result.imported;
        assert.isDefined(b);
        if (b === undefined) return;
        const got = yield* client.profiles.get({ params: { id: b.id } });
        assert.strictEqual(got.model, '/models/b.gguf');
      }),
    );

    it.effect('update replaces the profile', () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const source = yield* client.profiles.create({ payload: input('Up', { port: 8086 }) });
        const updated = yield* client.profiles.update({ params: { id: source.id }, payload: input('Up 2') });
        assert.strictEqual(updated.name, 'Up 2');
        assert.isFalse('port' in updated);
      }),
    );
  });
});
