import { Api, type BenchLive, type BenchRun } from '@llama-webui/shared';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeCall } from './api';
import { EMPTY_FORM, formFromSpec, makeBenchStore, specFromForm } from './bench';

// The browser resolves the client's relative URLs against the page; Vitest's node environment has no page.
beforeEach(() => {
  vi.stubGlobal('location', new URL('http://llama-webui.test/'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('a -ts without -dev survives the form', () => {
  const form = formFromSpec({
    modelPath: '/m/a.gguf',
    mmprojPath: null,
    profileId: null,
    params: { ts: [57, 50] },
    serverArgs: [],
  });
  const built = specFromForm(form);
  expect('spec' in built && built.spec.params).toEqual({ ts: [57, 50] });
});

test("a llama-bench run keeps the profile's projector", () => {
  const form = formFromSpec({
    kind: 'bench',
    modelPath: '/m/a.gguf',
    mmprojPath: '/m/mmproj.gguf',
    profileId: null,
    params: {},
    serverArgs: [],
  });
  const built = specFromForm(form);
  expect('spec' in built && built.spec.mmprojPath).toBe('/m/mmproj.gguf');
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const run = (r: Partial<BenchRun> & Pick<BenchRun, 'id'>): BenchRun => ({
  kind: 'bench',
  status: 'running',
  spec: {
    kind: 'bench',
    modelPath: '/m/a.gguf',
    mmprojPath: null,
    profileId: null,
    p: 512,
    n: 128,
    r: 3,
    params: {},
    serverArgs: [],
  },
  command: 'llama-bench -m /m/a.gguf',
  hardware: { cpu: '', gpus: [], build: null },
  pp: null,
  tg: null,
  draftAcceptPct: null,
  vramPeak: [],
  error: null,
  logExcerpt: '',
  durationMs: null,
  diskReadPeakBps: null,
  sweepId: null,
  sweepLabel: null,
  fit: null,
  createdAt: 1,
  ...r,
});

const live = (l: Partial<BenchLive> & Pick<BenchLive, 'runId'>): BenchLive => ({
  kind: 'bench',
  phase: 'loading',
  step: null,
  startedAt: 1,
  lines: [],
  ...l,
});

/** The store on a fake server: `routes` answers `METHOD /path` (in order when a list), `seen` records each request. */
function server(routes: Record<string, () => Response>) {
  const seen: Array<{ route: string; query: string; body: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    seen.push({ route, query: url.search, body: init?.body ? await new Response(init.body).text() : '' });
    const answer = routes[route];
    return answer ? answer() : json(404, { _tag: 'RouteNotFound', message: 'Unknown route' });
  }) as typeof fetch;
  const store = makeBenchStore({ call: makeCall(Api, fetchImpl) });
  return { store, seen };
}

/** A form ready to run: a model, the defaults. */
const ready = { ...EMPTY_FORM, modelPath: '/m/a.gguf' };

test('run posts the spec and stopServer and adds the run', async () => {
  const { store, seen } = server({ 'POST /api/bench/run': () => json(202, run({ id: 7 })) });
  store.getState().setForm(ready);

  await expect(store.getState().launch(true)).resolves.toBe('ok');
  expect(seen.map((s) => s.route)).toEqual(['POST /api/bench/run']);
  expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
    spec: {
      kind: 'bench',
      modelPath: '/m/a.gguf',
      mmprojPath: null,
      profileId: null,
      params: {},
      serverArgs: [],
      p: 512,
      n: 128,
      r: 3,
    },
    stopServer: true,
  });
  expect(store.getState().runs.map((r) => r.id)).toEqual([7]);
  expect(store.getState().launching).toBe(false);
});

test('a spec the schema refuses is shown on its field and nothing is sent', async () => {
  const { store, seen } = server({});
  store.getState().setForm({ ...ready, ngl: 'lots', r: '0' });

  await expect(store.getState().launch()).resolves.toBe('error');
  expect(seen).toEqual([]);
  expect(Object.keys(store.getState().errors).sort()).toEqual(['ngl', 'r']);
});

test('a bench-run, bench-progress or bench-deleted message updates the store', () => {
  const { store } = server({});
  const { receive } = store.getState();

  receive({ type: 'bench-run', payload: run({ id: 1 }) });
  receive({ type: 'bench-run', payload: run({ id: 2 }) });
  expect(store.getState().runs.map((r) => r.id)).toEqual([2, 1]);
  receive({ type: 'bench-run', payload: run({ id: 1, status: 'ok' }) });
  expect(store.getState().runs.map((r) => [r.id, r.status])).toEqual([
    [2, 'running'],
    [1, 'ok'],
  ]);
  // A sweep item is not listed while the history shows the one-off runs only.
  receive({ type: 'bench-run', payload: run({ id: 3, sweepId: 9 }) });
  expect(store.getState().runs.map((r) => r.id)).toEqual([2, 1]);

  receive({ type: 'bench-progress', payload: live({ runId: 2, phase: 'prompt' }) });
  expect(store.getState().live).toEqual(live({ runId: 2, phase: 'prompt' }));
  receive({ type: 'bench-progress', payload: null });
  expect(store.getState().live).toBeNull();

  store.getState().toggle(1);
  receive({ type: 'bench-deleted', payload: { ids: [1] } });
  expect(store.getState().runs.map((r) => r.id)).toEqual([2]);
  expect(store.getState().selected).toEqual([]);
});

test('a ServerRunning refusal is told by its tag and offers to stop the server', async () => {
  const error = vi.spyOn(toast, 'error').mockImplementation(() => 0);
  const answers = [
    json(409, {
      _tag: 'ServerRunning',
      message: 'llama-server is running (profile p): it will be stopped during the benchmark, then restarted',
    }),
    json(202, run({ id: 4 })),
  ];
  const { store, seen } = server({ 'POST /api/bench/run': () => answers.shift() ?? json(500, {}) });
  store.getState().setForm(ready);

  await expect(store.getState().launch()).resolves.toBe('confirm');
  expect(error).not.toHaveBeenCalled();
  await expect(store.getState().launch(true)).resolves.toBe('ok');
  expect(seen.map((s) => JSON.parse(s.body).stopServer)).toEqual([false, true]);

  // Another refusal of the same status is an error, told by its message.
  const busy = server({
    'POST /api/bench/run': () => json(409, { _tag: 'BenchRunning', message: 'A benchmark is running' }),
  });
  busy.store.getState().setForm(ready);
  await expect(busy.store.getState().launch()).resolves.toBe('error');
  expect(error).toHaveBeenCalledWith('A benchmark is running');
});

test('deleteFailed sends failed=1', async () => {
  vi.spyOn(toast, 'success').mockImplementation(() => 0);
  const { store, seen } = server({
    'DELETE /api/bench/runs': () => json(200, { deleted: 2 }),
    'GET /api/bench/runs': () => json(200, { runs: [], live: null }),
  });

  await store.getState().removeFailed();
  expect(seen.map((s) => `${s.route}${s.query}`)).toEqual([
    'DELETE /api/bench/runs?failed=1',
    'GET /api/bench/runs?sweep=none&limit=500',
  ]);
  expect(toast.success).toHaveBeenCalledWith('2 runs deleted');
});
