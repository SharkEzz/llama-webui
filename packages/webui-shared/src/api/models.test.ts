import { Exit, Option, Schema, String as Str } from 'effect';
import { HttpApi } from 'effect/http-api';
import { assert, expect, test } from 'vitest';
import { DownloadItem } from '../hf.ts';
import { STRICT } from '../profile.ts';
import { DownloadsApi } from './DownloadsApi.ts';
import { issuesOf } from './errors.ts';
import { HfApi } from './HfApi.ts';
import { ModelsApi } from './ModelsApi.ts';

/** The decoder of an endpoint's query, as the server applies it (strict, every issue). */
const queryOf = (endpoint: { readonly query: Schema.Top | undefined }) => {
  assert(endpoint.query !== undefined, 'the endpoint declares a query');
  // `query` is typed `Schema.Top` on the endpoint: its own type lives in the phantom `~Query`.
  return Schema.decodeUnknownExit(endpoint.query as Schema.Decoder<unknown>, STRICT);
};

/** The issues of an input refused by `decode`, none when it decodes. */
const refused = (exit: Exit.Exit<unknown, Schema.SchemaError>) =>
  Option.map(Exit.findErrorOption(exit), (error) => issuesOf(error.issue));

test('the search query is trimmed and refused when empty or over 200 characters', () => {
  const decode = queryOf(HfApi.endpoints.search);
  const message = 'Search text expected (200 characters at most)';
  expect(decode({ q: '  qwen3 0.6b  ' })).toEqual(Exit.succeed({ q: 'qwen3 0.6b' }));
  expect(decode({ q: ` ${Str.repeat(200)('a')} ` })).toEqual(Exit.succeed({ q: Str.repeat(200)('a') }));
  expect(refused(decode({ q: '   ' }))).toEqual(Option.some([{ path: ['q'], message }]));
  expect(refused(decode({ q: Str.repeat(201)('a') }))).toEqual(Option.some([{ path: ['q'], message }]));
  expect(refused(decode({}))).toEqual(Option.some([{ path: ['q'], message }]));
});

test('the repo id names the id it refuses', () => {
  const decode = queryOf(HfApi.endpoints.repo);
  expect(decode({ id: 'unsloth/Qwen3-0.6B-GGUF' })).toEqual(Exit.succeed({ id: 'unsloth/Qwen3-0.6B-GGUF' }));
  expect(decode({ id: 'org/name', revision: 'main' })).toEqual(Exit.succeed({ id: 'org/name', revision: 'main' }));
  expect(refused(decode({ id: '../etc' }))).toEqual(
    Option.some([{ path: ['id'], message: 'Invalid repository id: ../etc' }]),
  );
  expect(refused(decode({ id: 'org/name/extra' }))).toEqual(
    Option.some([{ path: ['id'], message: 'Invalid repository id: org/name/extra' }]),
  );
});

test('the info path must be absolute and end in .gguf', () => {
  const decode = queryOf(ModelsApi.endpoints.info);
  const message = 'Absolute path to a .gguf file expected';
  expect(decode({ path: '/models/q/a.gguf' })).toEqual(Exit.succeed({ path: '/models/q/a.gguf' }));
  for (const path of ['q/a.gguf', '/models/q/a.bin', '/models/q/a.gguf.part', ''])
    expect(refused(decode({ path }))).toEqual(Option.some([{ path: ['path'], message }]));
  expect(refused(decode({}))).toEqual(Option.some([{ path: ['path'], message }]));
});

test('the usage path is required', () => {
  const decode = queryOf(ModelsApi.endpoints.usage);
  expect(decode({ path: 'q/a.gguf' })).toEqual(Exit.succeed({ path: 'q/a.gguf' }));
  for (const input of [{ path: '' }, {}])
    expect(refused(decode(input))).toEqual(Option.some([{ path: ['path'], message: 'path required' }]));
});

test('a DownloadItem with any stored code decodes', () => {
  const item = {
    id: 3,
    repo: 'org/repo',
    revision: Str.repeat(40)('a'),
    key: 'Q4_K_M/m-00001-of-00002.gguf',
    name: 'm',
    quant: 'Q4_K_M',
    kind: 'model',
    dir: '/models/org/repo',
    files: [{ path: 'Q4_K_M/m-00001-of-00002.gguf', size: 1024, sha256: null, done: true }],
    status: 'error',
    bytesDone: 1024,
    totalBytes: 2048,
    error: 'something new',
    code: 'a-code-written-by-a-later-version',
    createdAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
  };
  const decoded = Schema.decodeUnknownExit(DownloadItem)(item);
  expect(decoded).toEqual(Exit.succeed(item));
  expect(Schema.encodeUnknownExit(DownloadItem)(item)).toEqual(Exit.succeed(item));
});

test('every new endpoint is in its group', () => {
  // The groups join `Api` with their handlers (Tasks 4, 5 and 8), as `ChatApi` did in E5: `HttpApiBuilder.layer(Api)`
  // needs a handler for every group, and the contract a case for every endpoint.
  const listed: Array<string> = [];
  HttpApi.reflect(HttpApi.make('e6').add(ModelsApi).add(HfApi).add(DownloadsApi), {
    onGroup: () => undefined,
    onEndpoint: ({ endpoint }) => {
      listed.push(`${endpoint.method} ${endpoint.path}`);
    },
  });
  const added = [
    'GET /api/models',
    'DELETE /api/models',
    'GET /api/models/info',
    'GET /api/models/usage',
    'GET /api/hf/repo',
    'GET /api/hf/search',
    'GET /api/hf/status',
    'GET /api/downloads',
    'POST /api/downloads',
    'POST /api/downloads/clear',
    'DELETE /api/downloads/:id',
    'POST /api/downloads/:id/retry',
  ];
  expect(listed).toEqual(added);
});
