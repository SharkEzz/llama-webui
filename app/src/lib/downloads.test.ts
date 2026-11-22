import { Api, type DownloadItem, type DownloadLive } from '@llama-webui/shared';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeCall } from './api';
import { makeDownloadsStore, queueProgress } from './downloads';

// The browser resolves the client's relative URLs against the page; Vitest's node environment has no page.
beforeEach(() => {
  vi.stubGlobal('location', new URL('http://llama-webui.test/'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SHA = 'a'.repeat(40);

const item = (i: Partial<DownloadItem> & Pick<DownloadItem, 'id'>): DownloadItem => ({
  repo: 'org/repo-GGUF',
  revision: SHA,
  key: 'repo-Q4_K_M.gguf',
  name: 'repo-Q4_K_M.gguf',
  quant: 'Q4_K_M',
  kind: 'model',
  dir: '/models/org/repo-GGUF',
  files: [{ path: 'repo-Q4_K_M.gguf', size: 1000, sha256: null, done: false }],
  status: 'queued',
  bytesDone: 0,
  totalBytes: 1000,
  error: null,
  code: null,
  createdAt: 1,
  finishedAt: null,
  ...i,
});

const live = (l: Partial<DownloadLive> & Pick<DownloadLive, 'id'>): DownloadLive => ({
  phase: 'downloading',
  file: 'repo-Q4_K_M.gguf',
  bytesDone: 0,
  totalBytes: 1000,
  bps: 0,
  retryAt: null,
  ...l,
});

/**
 * The store on a fake server: `routes` answers `METHOD /path`, and `seen` records each request with its body.
 * `downloaded` records the items a `download` message reports finished.
 */
function server(routes: Record<string, () => Response>) {
  const seen: Array<{ route: string; query: string; body: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    seen.push({ route, query: url.search, body: init?.body ? await new Response(init.body).text() : '' });
    const answer = routes[route];
    return answer ? answer() : json(404, { _tag: 'RouteNotFound', message: 'Unknown route' });
  }) as typeof fetch;
  const downloaded = vi.fn<(i: DownloadItem) => void>();
  const navigate = vi.fn<(to: string) => void>();
  const store = makeDownloadsStore({ call: makeCall(Api, fetchImpl), downloaded, navigate });
  return { store, seen, downloaded, navigate };
}

test('download posts the repo, revision and keys and adds the items', async () => {
  const queued = [item({ id: 1 }), item({ id: 2, key: 'mmproj-F16.gguf', name: 'mmproj-F16.gguf', kind: 'mmproj' })];
  const { store, seen } = server({ 'POST /api/downloads': () => json(202, { items: queued }) });

  await expect(store.getState().enqueue('org/repo-GGUF', SHA, ['repo-Q4_K_M.gguf', 'mmproj-F16.gguf'])).resolves.toBe(
    true,
  );
  expect(seen.map((s) => s.route)).toEqual(['POST /api/downloads']);
  expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
    repo: 'org/repo-GGUF',
    revision: SHA,
    keys: ['repo-Q4_K_M.gguf', 'mmproj-F16.gguf'],
  });
  expect(store.getState().items).toEqual(queued);

  // The queue's own message for an item already added replaces it, it does not add it twice.
  store.getState().receive({ type: 'download', payload: queued[0]! });
  expect(store.getState().items).toEqual(queued);
});

test('a reply that arrives after the queue has moved on does not undo its message', async () => {
  // The queue starts (and here fails) the item before the reply of its request reaches the page.
  const { store } = server({
    'POST /api/downloads': () => {
      store.getState().receive({ type: 'download', payload: item({ id: 1, status: 'downloading' }) });
      return json(202, { items: [item({ id: 1 })] });
    },
    'POST /api/downloads/1/retry': () => {
      store.getState().receive({ type: 'download', payload: item({ id: 1, status: 'error', error: 'gated' }) });
      return json(202, item({ id: 1 }));
    },
  });
  vi.spyOn(toast, 'error').mockImplementation(() => 0);

  await store.getState().enqueue('org/repo-GGUF', SHA, ['repo-Q4_K_M.gguf']);
  expect(store.getState().items.map((i) => i.status)).toEqual(['downloading']);
  await store.getState().retry(1);
  expect(store.getState().items.map((i) => i.status)).toEqual(['error']);
});

test('a download, download-progress or download-deleted message updates the store', () => {
  const { store, downloaded, navigate } = server({});
  const success = vi.spyOn(toast, 'success');
  const error = vi.spyOn(toast, 'error');

  store.getState().receive({ type: 'download', payload: item({ id: 1 }) });
  store.getState().receive({ type: 'download', payload: item({ id: 2 }) });
  expect(store.getState().items.map((i) => i.id)).toEqual([1, 2]);

  store.getState().receive({ type: 'download', payload: item({ id: 1, status: 'downloading' }) });
  store.getState().receive({ type: 'download-progress', payload: live({ id: 1, bytesDone: 400 }) });
  expect(store.getState().items[0]?.status).toBe('downloading');
  expect(store.getState().live).toEqual(live({ id: 1, bytesDone: 400 }));

  const done = item({ id: 1, status: 'done', bytesDone: 1000, finishedAt: 2 });
  store.getState().receive({ type: 'download', payload: done });
  store.getState().receive({ type: 'download-progress', payload: null });
  expect(store.getState().items).toEqual([done, item({ id: 2 })]);
  expect(store.getState().live).toBeNull();
  // A finished download is told once: the models folder changed.
  expect(downloaded).toHaveBeenCalledExactlyOnceWith(done);
  expect(success).toHaveBeenCalledOnce();
  // Its Details opens the model on the Models page, through the navigation the store was given.
  const action = success.mock.calls[0]?.[1]?.action;
  expect(action).toMatchObject({ label: 'Details' });
  if (action && typeof action === 'object' && 'onClick' in action) action.onClick({} as never);
  expect(navigate).toHaveBeenCalledExactlyOnceWith(
    `/models?open=${encodeURIComponent('/models/org/repo-GGUF/repo-Q4_K_M.gguf')}`,
  );
  store.getState().receive({ type: 'download', payload: done });
  expect(downloaded).toHaveBeenCalledOnce();

  store.getState().receive({ type: 'download', payload: item({ id: 2, status: 'error', error: 'Checksum mismatch' }) });
  expect(error).toHaveBeenCalledExactlyOnceWith('Download of repo-Q4_K_M.gguf (Q4_K_M) failed', {
    description: 'Checksum mismatch',
  });

  store.getState().receive({ type: 'download-deleted', payload: { ids: [1, 2] } });
  expect(store.getState().items).toEqual([]);
});

test('a Hub error is told by its tag: HfGated, HfNotFound', async () => {
  const gated = { _tag: 'HfGated', message: 'org/gated is gated: accept its license on Hugging Face' };
  const missing = { _tag: 'HfNotFound', message: 'No GGUF “x.gguf” in org/repo-GGUF' };
  const { store, seen } = server({
    'GET /api/hf/repo': () => json(403, gated),
    'POST /api/downloads': () => json(404, missing),
  });
  const shown = vi.spyOn(toast, 'error');

  await expect(store.getState().repo('org/gated')).rejects.toMatchObject(gated);
  expect(seen[0]).toMatchObject({ route: 'GET /api/hf/repo', query: '?id=org%2Fgated' });

  // A refused request shows the message and adds nothing.
  await expect(store.getState().enqueue('org/repo-GGUF', SHA, ['x.gguf'])).resolves.toBe(false);
  expect(shown).toHaveBeenCalledExactlyOnceWith(missing.message);
  expect(store.getState().items).toEqual([]);
});

test('load reads the queue and its live progress', async () => {
  const list = { items: [item({ id: 1, status: 'downloading' })], live: live({ id: 1, bytesDone: 10 }) };
  const { store } = server({ 'GET /api/downloads': () => json(200, list) });
  await store.getState().load();
  expect(store.getState()).toMatchObject(list);
});

test('a message that arrives while the queue is read is kept: the list read before it does not undo it', async () => {
  // The queue moves on while its list travels: item 1 starts, item 2 is cleared, item 3 is queued, a file progresses.
  const { store } = server({
    'GET /api/downloads': () => {
      store.getState().receive({ type: 'download', payload: item({ id: 1, status: 'downloading' }) });
      store.getState().receive({ type: 'download-deleted', payload: { ids: [2] } });
      store.getState().receive({ type: 'download', payload: item({ id: 3 }) });
      store.getState().receive({ type: 'download-progress', payload: live({ id: 1, bytesDone: 10 }) });
      return json(200, { items: [item({ id: 1 }), item({ id: 2, status: 'done' }), item({ id: 4 })], live: null });
    },
  });
  await store.getState().load();
  expect(store.getState().items).toEqual([item({ id: 1, status: 'downloading' }), item({ id: 4 }), item({ id: 3 })]);
  expect(store.getState().live).toEqual(live({ id: 1, bytesDone: 10 }));
  // Once read, the list is the queue again: a later load replaces what the messages had set.
  const { store: next } = server({ 'GET /api/downloads': () => json(200, { items: [item({ id: 5 })], live: null }) });
  next.getState().receive({ type: 'download', payload: item({ id: 1 }) });
  await next.getState().load();
  expect(next.getState().items).toEqual([item({ id: 5 })]);
});

test('an enqueue or retry reply that comes after its item was cleared does not bring it back', async () => {
  const { store } = server({
    'POST /api/downloads': () => {
      // Queued, finished at once (every file on disk) and cleared, all before the reply.
      store.getState().receive({ type: 'download', payload: item({ id: 1 }) });
      store.getState().receive({ type: 'download-deleted', payload: { ids: [1] } });
      return json(202, { items: [item({ id: 1 }), item({ id: 2 })] });
    },
    'POST /api/downloads/3/retry': () => {
      store.getState().receive({ type: 'download-deleted', payload: { ids: [3] } });
      return json(202, item({ id: 3 }));
    },
  });
  await store.getState().enqueue('org/repo-GGUF', SHA, ['repo-Q4_K_M.gguf']);
  expect(store.getState().items.map((i) => i.id)).toEqual([2]);
  await store.getState().retry(3);
  expect(store.getState().items.map((i) => i.id)).toEqual([2]);
});

test('cancel, retry and clear call their endpoint; a refusal shows its message', async () => {
  const { store, seen } = server({
    'DELETE /api/downloads/3': () => new Response(null, { status: 204 }),
    'POST /api/downloads/4/retry': () =>
      json(409, { _tag: 'NotFinished', message: 'Only a failed or canceled download can be retried' }),
    'POST /api/downloads/clear': () => json(200, { deleted: 2 }),
  });
  const shown = vi.spyOn(toast, 'error');
  await store.getState().cancel(3);
  await store.getState().retry(4);
  await store.getState().clearFinished();
  expect(seen.map((s) => s.route)).toEqual([
    'DELETE /api/downloads/3',
    'POST /api/downloads/4/retry',
    'POST /api/downloads/clear',
  ]);
  expect(shown).toHaveBeenCalledExactlyOnceWith('Only a failed or canceled download can be retried');
});

test('queueProgress sums the finished files and the live bytes', () => {
  const running = item({ id: 1, status: 'downloading', bytesDone: 200, totalBytes: 1000 });
  const queued = item({ id: 2, totalBytes: 1000 });
  const done = item({ id: 3, status: 'done', bytesDone: 5000, totalBytes: 5000 });

  expect(queueProgress([done], null)).toBeNull();
  // Without live progress: the finished files of the active items.
  expect(queueProgress([running, queued, done], null)).toBe(0.1);
  // The live bytes of the running item replace its finished files.
  expect(queueProgress([running, queued, done], live({ id: 1, bytesDone: 600 }))).toBe(0.3);
  expect(queueProgress([item({ id: 4, totalBytes: 0 })], null)).toBe(0);
});
