import { Exit, Option, Schema } from 'effect';
import { HttpApi } from 'effect/http-api';
import { assert, expect, test } from 'vitest';
import { BenchParams, BenchRun } from '../bench.ts';
import { STRICT } from '../profile.ts';
import { BenchApi } from './BenchApi.ts';
import { issuesOf } from './errors.ts';
import { SweepsApi, ValidateRequest } from './SweepsApi.ts';

/** The decoder of an endpoint's query, as the server applies it (strict, every issue). */
const decoderOf = (schema: Schema.Top | undefined) => {
  assert(schema !== undefined, 'the endpoint declares it');
  // Typed `Schema.Top` on the endpoint: its own type lives in a phantom member.
  return Schema.decodeUnknownExit(schema as Schema.Decoder<unknown>, STRICT);
};

/** The issues of an input refused by `decode`, none when it decodes. */
const refused = (exit: Exit.Exit<unknown, Schema.SchemaError>) =>
  Option.map(Exit.findErrorOption(exit), (error) => issuesOf(error.issue));

test('the runs query accepts any string and the deleteFailed query refuses anything but 1', () => {
  const runs = decoderOf(BenchApi.endpoints.runs.query);
  const query = { kind: 'nope', status: 'weird', model: '/m/a.gguf', sweep: 'all', limit: '-3' };
  expect(runs(query)).toEqual(Exit.succeed(query));
  expect(runs({})).toEqual(Exit.succeed({}));

  const deleteFailed = decoderOf(BenchApi.endpoints.deleteFailed.query);
  const message = '?failed=1 expected';
  expect(deleteFailed({ failed: '1' })).toEqual(Exit.succeed({ failed: '1' }));
  for (const input of [{ failed: '0' }, { failed: 'true' }, {}])
    expect(refused(deleteFailed(input))).toEqual(Option.some([{ path: ['failed'], message }]));
});

test('a BenchRun with a Nitro-written spec and empty hardware decodes', () => {
  // As the Nitro server wrote it: every key of the spec present, a value a rule of today refuses (`ngl` 12000, a
  // serverArgs flag now covered by a field), and the hardware of a queued item read as none.
  const run = {
    id: 7,
    kind: 'bench',
    status: 'failed',
    spec: {
      kind: 'bench',
      modelPath: 'models/a.gguf',
      mmprojPath: null,
      profileId: null,
      p: 512,
      n: 128,
      r: 3,
      params: { ngl: 12000, ts: [0.5, 1.5] },
      serverArgs: ['-ngl', '20'],
    },
    command: '',
    hardware: { cpu: '', gpus: [], build: null },
    pp: null,
    tg: { tps: 41.25, stddev: 0.5, tokens: 128 },
    draftAcceptPct: 47.5,
    vramPeak: [{ key: 'nvidia:GPU-1', name: 'Fake GPU', mib: 2048 }],
    error: 'Out of memory: unable to allocate',
    logExcerpt: 'line',
    durationMs: 1234,
    diskReadPeakBps: 1.5e9,
    sweepId: 2,
    sweepLabel: '-ncmoe 8',
    fit: 'tight',
    createdAt: 1_700_000_000_000,
  };
  expect(Schema.decodeUnknownExit(BenchRun)(run)).toEqual(Exit.succeed(run));
  // The same params as a person writes them: the input rules refuse them.
  expect(refused(Schema.decodeExit(BenchParams, STRICT)(run.spec.params))).toEqual(
    Option.some([{ path: ['ngl'], message: 'a number, “all” or “auto”' }]),
  );
});

test('the validate payload defaults n to 3 and refuses an unknown key', () => {
  const validate = Schema.decodeUnknownExit(ValidateRequest, STRICT);
  expect(validate({})).toEqual(Exit.succeed({ n: 3 }));
  expect(validate({ n: 1, stopServer: true })).toEqual(Exit.succeed({ n: 1, stopServer: true }));
  expect(refused(validate({ n: 3, extra: 1 }))).toEqual(Option.some([{ path: ['extra'], message: 'unknown key' }]));
  expect(Exit.isFailure(validate({ n: 6 }))).toBe(true);
  expect(Exit.isFailure(validate({ n: 1.5 }))).toBe(true);
});

test('every new endpoint is in the API definition', () => {
  // The groups join `Api` with their handlers (Task 8), as the E6 groups did: `HttpApiBuilder.layer(Api)` needs a
  // handler for every group, and the contract a case for every endpoint.
  const listed: Array<string> = [];
  HttpApi.reflect(HttpApi.make('e7').add(BenchApi).add(SweepsApi), {
    onGroup: () => undefined,
    onEndpoint: ({ endpoint }) => {
      listed.push(`${endpoint.method} ${endpoint.path}`);
    },
  });
  expect(listed).toEqual([
    'GET /api/bench/devices',
    'GET /api/bench/from-profile/:id',
    'GET /api/bench/runs',
    'DELETE /api/bench/runs',
    'POST /api/bench/run',
    'DELETE /api/bench/:id',
    'POST /api/bench/:id/cancel',
    'POST /api/bench/:id/to-profile',
    'GET /api/sweeps',
    'POST /api/sweeps',
    'GET /api/sweeps/:id',
    'DELETE /api/sweeps/:id',
    'POST /api/sweeps/:id/cancel',
    'POST /api/sweeps/:id/resume',
    'POST /api/sweeps/:id/validate',
  ]);
});
