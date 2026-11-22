import { Api, type ModelEntry, type ModelKind, type ModelList } from '@llama-webui/shared';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeCall } from './api';
import { makeModelsStore, matchingProjector } from './models';

// The browser resolves the client's relative URLs against the page; Vitest's node environment has no page.
beforeEach(() => {
  vi.stubGlobal('location', new URL('http://llama-webui.test/'));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const entry = (path: string, kind: ModelKind = 'model'): ModelEntry => ({
  ok: true,
  path,
  relPath: path.replace(/^\/models\//, ''),
  files: [path],
  fileBytes: 1024,
  kind,
  arch: 'llama',
  name: '',
  quant: 'Q4_K_M',
  params: 1,
  blockCount: 1,
  contextLength: 0,
  embeddingLength: 0,
  headCount: 0,
  headCountKv: 0,
  expertCount: 0,
  expertUsedCount: 0,
  nextnLayers: 0,
  recurrent: false,
  slidingWindow: null,
  hasChatTemplate: false,
});

const list = (models: ReadonlyArray<ModelEntry>): ModelList => ({
  dir: '/models',
  setting: '~/models',
  home: '/home/u',
  scannedAt: 1,
  models,
});

/**
 * The store on a fake server: `routes` answers `METHOD /path` (a list answers once per request, its last answer
 * after; an answer that is an error makes the request fail without a reply), and `seen` records each request with
 * its body.
 */
function server(routes: Record<string, ReadonlyArray<Response | Error>>) {
  const seen: Array<{ route: string; body: string }> = [];
  const asked = new Map<string, number>();
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const route = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
    seen.push({ route, body: init?.body ? await new Response(init.body).text() : '' });
    const n = asked.get(route) ?? 0;
    asked.set(route, n + 1);
    const answers = routes[route];
    const answer = answers?.[Math.min(n, answers.length - 1)];
    if (answer === undefined) return json(404, { _tag: 'RouteNotFound', message: 'Unknown route' });
    if (answer instanceof Error) throw answer;
    return answer.clone();
  }) as typeof fetch;
  const store = makeModelsStore({ call: makeCall(Api, fetchImpl) });
  return { store, seen };
}

test('reload stores the list and keeps the last error', async () => {
  const first = list([entry('/models/a.gguf')]);
  const second = list([entry('/models/a.gguf'), entry('/models/b.gguf')]);
  const { store } = server({ 'GET /api/models': [json(200, first), new TypeError('fetch failed'), json(200, second)] });

  await store.getState().refresh();
  expect(store.getState()).toMatchObject({ list: first, error: null, loading: false });

  // The server went away: the list stays as it was, the error says why.
  await store.getState().refresh();
  expect(store.getState()).toMatchObject({ list: first, error: 'llama-webui server unreachable', loading: false });

  await store.getState().refresh();
  expect(store.getState()).toMatchObject({ list: second, error: null, loading: false });
});

test('deleteModel sends the path and deleteProfiles', async () => {
  const deleted = { deletedFiles: ['/models/a.gguf'], deletedProfiles: [3] };
  const { store, seen } = server({
    'DELETE /api/models': [json(200, deleted)],
    'GET /api/models': [json(200, list([]))],
  });

  await expect(store.getState().deleteModel('/models/a.gguf', true)).resolves.toEqual(deleted);
  expect(seen[0]?.route).toBe('DELETE /api/models');
  expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ path: '/models/a.gguf', deleteProfiles: true });
  // The folder changed: the list is read again.
  expect(seen.map((s) => s.route)).toEqual(['DELETE /api/models', 'GET /api/models']);
  expect(store.getState().list).toEqual(list([]));
});

test('deleteModel rejects with the tag of a refusal and reads nothing again', async () => {
  const { store, seen } = server({
    'DELETE /api/models': [json(409, { _tag: 'ModelInUse', message: 'A download in progress writes it' })],
  });

  await expect(store.getState().deleteModel('/models/a.gguf', false)).rejects.toMatchObject({
    _tag: 'ModelInUse',
    message: 'A download in progress writes it',
  });
  expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ path: '/models/a.gguf', deleteProfiles: false });
  expect(seen.map((s) => s.route)).toEqual(['DELETE /api/models']);
});

test('usage asks for the path and returns what the deletion would remove', async () => {
  const usage = { path: '/models/a.gguf', files: ['/models/a.gguf'], fileBytes: 1024, profiles: [], blocked: null };
  const { store, seen } = server({ 'GET /api/models/usage': [json(200, usage)] });
  await expect(store.getState().usage('/models/a.gguf')).resolves.toEqual(usage);
  expect(seen[0]?.route).toBe('GET /api/models/usage');
});

test("matchingProjector picks the projector of the model's folder", () => {
  const model = '/models/qwen/Qwen3-8B-Q4_K_M.gguf';
  const here = entry('/models/qwen/mmproj-Qwen3-8B-F16.gguf', 'mmproj');
  const elsewhere = entry('/models/other/mmproj-Qwen3-8B-F16.gguf', 'mmproj');
  const otherModel = entry('/models/qwen/mmproj-Gemma3-4B-F16.gguf', 'mmproj');

  expect(matchingProjector(model, [entry(model), elsewhere, here, otherModel])).toBe(here.path);
  // Only in another folder: none.
  expect(matchingProjector(model, [entry(model), elsewhere])).toBeNull();
  // Two that match in the folder: none rather than a guess.
  const twin = entry('/models/qwen/Qwen3-8B-BF16-mmproj.gguf', 'mmproj');
  expect(matchingProjector(model, [entry(model), here, twin])).toBeNull();
});
