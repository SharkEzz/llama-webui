import { Exit, Option, Schema } from 'effect';
import { HttpApi } from 'effect/http-api';
import { expect, test } from 'vitest';
import { issuesOf } from './api/errors.ts';
import { SetupApi } from './api/SetupApi.ts';
import { SweepRequest } from './api/SweepsApi.ts';
import { PlanRequest, TuningApi } from './api/TuningApi.ts';
import { STRICT } from './profile.ts';
import { DiskSpeedRequest, EstimateRequest } from './tuning.ts';

const refusedBy =
  <S extends Schema.Decoder<unknown>>(schema: S) =>
  (input: unknown) =>
    Option.map(Exit.findErrorOption(Schema.decodeUnknownExit(schema, STRICT)(input)), (error) => issuesOf(error.issue));

test('EstimateRequest takes a model, a preset, pinned flags and a context between 512 and 10000000', () => {
  const decode = Schema.decodeUnknownExit(EstimateRequest, STRICT);
  const body = { modelPath: '/m/a.gguf', mmprojPath: null, preset: 'chat', pinned: { ngl: 'all' }, ctx: 4096 };
  expect(decode(body)).toEqual(Exit.succeed(body));
  const refused = refusedBy(EstimateRequest);
  expect(refused({ modelPath: '', preset: 'chat' })).toEqual(
    Option.some([{ path: ['modelPath'], message: 'cannot be empty' }]),
  );
  expect(refused({ modelPath: '/m/a.gguf', preset: 'chat', ctx: 511 })).toEqual(
    Option.some([{ path: ['ctx'], message: 'at least 512' }]),
  );
  expect(refused({ modelPath: '/m/a.gguf', preset: 'chat', ctx: 10_000_001 })).toEqual(
    Option.some([{ path: ['ctx'], message: 'at most 10000000' }]),
  );
  expect(refused({ modelPath: '/m/a.gguf', preset: 'chat', other: 1 })).toEqual(
    Option.some([{ path: ['other'], message: 'unknown key' }]),
  );
  expect(Option.isSome(refused({ modelPath: '/m/a.gguf', preset: 'fast' }))).toBe(true);
});

test('DiskSpeedRequest takes a non-empty model path and nothing else', () => {
  expect(Schema.decodeExit(DiskSpeedRequest, STRICT)({ modelPath: '/m/a.gguf' })).toEqual(
    Exit.succeed({ modelPath: '/m/a.gguf' }),
  );
  const refused = refusedBy(DiskSpeedRequest);
  expect(refused({ modelPath: '' })).toEqual(Option.some([{ path: ['modelPath'], message: 'cannot be empty' }]));
  expect(refused({ modelPath: '/m/a.gguf', x: 1 })).toEqual(Option.some([{ path: ['x'], message: 'unknown key' }]));
});

test('the plan and the creation of a sweep report the issues of the spec under spec', () => {
  expect(refusedBy(PlanRequest)({})).toEqual(Option.some([{ path: ['spec'], message: 'Missing key' }]));
  const issues = refusedBy(SweepRequest)({ spec: { modelPath: '/m/a.gguf', preset: 'chat' } });
  expect(Option.map(issues, (list) => list.map((i) => i.path))).toEqual(Option.some([['spec', 'name']]));
  expect(refusedBy(SweepRequest)({ spec: {}, stopServer: 'x' }).pipe(Option.map((l) => l.at(-1)))).toEqual(
    Option.some({ path: ['stopServer'], message: 'Expected boolean' }),
  );
});

test('the tuning and setup endpoints', () => {
  const listed: Array<string> = [];
  HttpApi.reflect(HttpApi.make('e8').add(TuningApi).add(SetupApi), {
    onGroup: () => undefined,
    onEndpoint: ({ endpoint }) => {
      listed.push(`${endpoint.method} ${endpoint.path}`);
    },
  });
  expect(listed).toEqual([
    'GET /api/tuning/checks',
    'GET /api/tuning/hardware',
    'POST /api/tuning/disk-speed',
    'POST /api/tuning/estimate',
    'POST /api/tuning/plan',
    'GET /api/setup',
  ]);
});
