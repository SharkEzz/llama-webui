import { Api, type HistoryDump, type Snapshot } from '@llama-webui/shared';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { create } from 'zustand';
import { makeCall } from './api';
import { makeMonitor } from './monitor';
import type { WsStatus } from './ws';

// The browser resolves the client's relative URLs against the page; Vitest's node environment has no page.
beforeEach(() => {
  vi.stubGlobal('location', new URL('http://llama-webui.test/'));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SHAPE = { intervalMs: 1000, capacity: 10 };

/** The snapshot of time `at` (s), with a point of `cpu` in the `sys.cpu` series. */
const snapshot = (at: number, cpu: number, shape = SHAPE): Snapshot => ({
  at: at * 1000,
  tick: at,
  health: null,
  rates: { genTps: 0, ppTps: 0 },
  slots: null,
  kv: null,
  queue: null,
  lastRequest: null,
  spec: null,
  recentRequests: [],
  gpus: [],
  allGpus: [],
  proc: null,
  system: null,
  disk: null,
  points: { 'sys.cpu': cpu },
  history: shape,
});

/** The server's history: the points of times 1 and 2. */
const DUMP: HistoryDump = { ...SHAPE, at: 2000, times: [1000, 2000], series: { 'sys.cpu': [10, 20] } };

/**
 * The store on a fake server and a push channel of its own; `reads` counts the reads of the history. `hold` keeps
 * the replies until `release`, to let snapshots arrive while the history is read.
 */
function setup(status: WsStatus, { hold = false } = {}) {
  let reads = 0;
  let waiting: Array<() => void> = [];
  const fetchImpl = ((input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== '/api/monitor/history')
      return Promise.resolve(json(404, { _tag: 'RouteNotFound', message: 'Unknown route' }));
    reads++;
    const reply = () => json(200, { ...DUMP, bootId: 'boot-1' });
    if (!hold) return Promise.resolve(reply());
    return new Promise<Response>((resolve) => waiting.push(() => resolve(reply())));
  }) as typeof fetch;
  const ws = create<{ status: WsStatus }>()(() => ({ status }));
  const monitor = makeMonitor({ call: makeCall(Api, fetchImpl), ws });
  const release = () => {
    for (const answer of waiting) answer();
    waiting = [];
  };
  return { monitor, ws, reads: () => reads, release };
}

/** Lets the requests in flight answer. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const series = (monitor: ReturnType<typeof makeMonitor>) => {
  const h = monitor.store.getState().history;
  return { times: h.times, cpu: h.series.get('sys.cpu') };
};

test('the history is read only once a chart asks for it; the snapshots before leave it empty', async () => {
  const { monitor, ws, reads } = setup('connecting');
  ws.setState({ status: 'open' });
  monitor.snapshot(snapshot(3, 30));
  // A shape that differs from the empty history's does not read it either.
  monitor.snapshot(snapshot(4, 40, { intervalMs: 2000, capacity: 5 }));
  ws.setState({ status: 'closed' });
  ws.setState({ status: 'open' });
  await settle();
  expect(reads()).toBe(0);
  expect(monitor.store.getState().snapshot?.at).toBe(4000);
  expect(series(monitor)).toEqual({ times: [], cpu: undefined });
});

test('a chart shown with the channel open reads the history at once, then each snapshot grows it', async () => {
  const { monitor, reads } = setup('open');
  monitor.snapshot(snapshot(1, 99));
  monitor.wantHistory();
  monitor.wantHistory();
  await settle();
  expect(reads()).toBe(1);
  expect(series(monitor)).toEqual({ times: [1, 2], cpu: [10, 20] });
  monitor.snapshot(snapshot(3, 30));
  expect(series(monitor)).toEqual({ times: [1, 2, 3], cpu: [10, 20, 30] });
});

test('a snapshot notifies the subscribers once, with the history it grew', async () => {
  const { monitor } = setup('open');
  monitor.wantHistory();
  await settle();
  const seen: Array<{ at: number | undefined; version: number }> = [];
  const unsubscribe = monitor.store.subscribe((st) => seen.push({ at: st.snapshot?.at, version: st.version }));
  const before = monitor.store.getState().version;
  monitor.snapshot(snapshot(3, 30));
  unsubscribe();
  expect(seen).toEqual([{ at: 3000, version: before + 1 }]);
});

test('the snapshots that arrive while the history is read are appended to it', async () => {
  const { monitor, release } = setup('open', { hold: true });
  monitor.wantHistory();
  monitor.snapshot(snapshot(2, 21));
  monitor.snapshot(snapshot(3, 30));
  release();
  await settle();
  expect(series(monitor)).toEqual({ times: [1, 2, 3], cpu: [10, 20, 30] });
});

test('a cold load reads the history when the channel opens, again on each reconnect and on a new shape', async () => {
  const { monitor, ws, reads } = setup('connecting');
  monitor.wantHistory();
  await settle();
  expect(reads()).toBe(0);
  ws.setState({ status: 'open' });
  await settle();
  expect(reads()).toBe(1);
  ws.setState({ status: 'closed' });
  ws.setState({ status: 'open' });
  await settle();
  expect(reads()).toBe(2);
  monitor.snapshot(snapshot(3, 30, { intervalMs: 2000, capacity: 10 }));
  await settle();
  expect(reads()).toBe(3);
});
