import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  addShift,
  changedKeys,
  clearCapture,
  debugCall,
  debugFrameSample,
  debugLayoutShift,
  debugLcp,
  debugNavigation,
  debugRender,
  debugResource,
  debugStoreChange,
  debugWs,
  markErrorsSeen,
  PUBLISH_MS,
  rate,
  Ring,
  SAMPLES,
  STORE_CHANGES,
  setDebugEnabled,
  setPaused,
  snapshot,
  useDebugCapture,
  WS_FRAMES,
} from './capture';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  setDebugEnabled(false);
  vi.useRealTimers();
});

test('a ring keeps the last items pushed, oldest first', () => {
  const ring = new Ring<number>(3);
  for (const n of [1, 2, 3, 4, 5]) ring.push(n);
  expect(ring.items()).toEqual([3, 4, 5]);
  ring.clear();
  expect(ring.items()).toEqual([]);
});

test('a rate counts the samples of the last five seconds, per second', () => {
  const samples: [number, number][] = [
    [1000, 100],
    [5000, 200],
    [7000, 300],
  ];
  // At 7000, the window is (2000, 7000]: the first sample has left it, and is dropped.
  expect(rate(samples, 7000)).toEqual({ perSecond: 2 / 5, bytesPerSecond: 500 / 5 });
  expect(samples).toHaveLength(2);
});

test('nothing is captured while the debug mode is off', () => {
  debugWs.frame('in', '{"type":"ping"}', { type: 'ping' });
  expect(debugCall()).toBeUndefined();
  debugRender('page', 'mount', 1, 1);
  debugNavigation('/', 3);
  debugLcp(1200, 'h1');
  debugLayoutShift(10, 0.2);
  debugFrameSample(60, 1000);
  debugResource({ at: 1, name: '/assets/a.js', type: 'script', transferBytes: 10, bytes: 20, ms: 3, cached: false });
  debugStoreChange('s', { n: 1 }, { n: 0 });
  const view = snapshot();
  expect(view.storeChanges).toEqual([]);
  expect(view.storeStats).toEqual([]);
  expect(view.perf.lcp).toBeUndefined();
  expect(view.perf.layoutShifts.count).toBe(0);
  expect(view.perf.samples).toEqual([]);
  expect(view.resources).toEqual([]);
  expect(view.frames).toEqual([]);
  expect(view.calls).toEqual([]);
  expect(view.renders).toEqual([]);
  expect(view.perf.navigations).toEqual([]);
});

test('turning the debug mode on starts from empty, turning it off drops what was captured', () => {
  setDebugEnabled(true);
  debugWs.frame('in', '{"type":"ping"}', { type: 'ping' });
  expect(snapshot().frames).toHaveLength(1);
  setDebugEnabled(false);
  expect(snapshot().frames).toEqual([]);
  setDebugEnabled(true);
  expect(snapshot().frames).toEqual([]);
});

test('the frames are bounded, and counted per type; a rejected frame is an error', () => {
  setDebugEnabled(true);
  for (let i = 0; i < WS_FRAMES + 10; i++) debugWs.frame('in', '{"type":"ping"}', { type: 'ping' });
  debugWs.frame('in', 'not json', undefined, 'Expected JSON');
  const view = snapshot();
  expect(view.frames).toHaveLength(WS_FRAMES);
  expect(view.frames.at(-1)).toMatchObject({ type: '?', data: 'not json', error: 'Expected JSON' });
  expect(view.wsTypes.find((t) => t.type === 'ping')).toMatchObject({ count: WS_FRAMES + 10 });
  expect(view.unseenErrors).toBe(1);
  markErrorsSeen();
  expect(snapshot().unseenErrors).toBe(0);
});

test('a hello gives the boot id, once per boot, and the clock offset', () => {
  setDebugEnabled(true);
  const now = Date.now();
  const hello = { type: 'hello', payload: { serverTime: now + 1500, bootId: 'boot-1' } } as const;
  debugWs.frame('in', JSON.stringify(hello), hello);
  debugWs.frame('in', JSON.stringify(hello), hello);
  const { ws } = snapshot();
  expect(ws.bootIds.map((b) => b.bootId)).toEqual(['boot-1']);
  expect(ws.clockOffsetMs).toBe(1500);
});

test('a call records its request, its response and how it ended', () => {
  setDebugEnabled(true);
  const call = debugCall();
  call?.request('GET', '/api/health');
  call?.response(200, 42);
  call?.end('ok', { reply: { ok: true } });
  const failed = debugCall();
  failed?.end('error', { tag: 'ApiUnreachable' });
  const [ok, error] = snapshot().calls;
  expect(ok).toMatchObject({
    method: 'GET',
    path: '/api/health',
    status: 200,
    bytes: 42,
    state: 'ok',
    reply: { ok: true },
  });
  expect(error).toMatchObject({ state: 'error', tag: 'ApiUnreachable' });
  expect(snapshot().unseenErrors).toBe(1);
});

test('a stream counts its events by type and the text they carry', () => {
  setDebugEnabled(true);
  const stream = debugCall(true);
  stream?.event({ type: 'start' });
  stream?.event({ type: 'delta', content: 'Hello', reasoning: '...' });
  stream?.event({ type: 'done' });
  stream?.end('aborted');
  const [s] = snapshot().streams;
  expect(s?.state).toBe('aborted');
  expect(s?.stream).toMatchObject({ events: 3, byType: { start: 1, delta: 1, done: 1 }, chars: 8 });
  expect(s?.stream?.firstEventMs).toBeTypeOf('number');
});

test('a navigation restarts the count of commits since the last one', () => {
  setDebugEnabled(true);
  debugRender('sidebar', 'mount', 2, 2);
  debugRender('sidebar', 'update', 4, 2);
  expect(snapshot().renders[0]).toMatchObject({
    commits: 2,
    mounts: 1,
    sumMs: 6,
    maxMs: 4,
    lastMs: 4,
    sinceNavigation: 2,
  });
  debugNavigation('/logs', 12);
  expect(snapshot().renders[0]?.sinceNavigation).toBe(0);
  expect(snapshot().perf.navigations).toMatchObject([{ path: '/logs', ms: 12 }]);
});

test('the view is published at most every 250 ms, and not while paused', () => {
  setDebugEnabled(true);
  const published = vi.fn<() => void>();
  const unsubscribe = useDebugCapture.subscribe(published);
  for (let i = 0; i < 10; i++) debugWs.frame('in', '{"type":"ping"}', { type: 'ping' });
  expect(published).not.toHaveBeenCalled();
  vi.advanceTimersByTime(PUBLISH_MS);
  expect(published).toHaveBeenCalledTimes(1);
  expect(useDebugCapture.getState().view.frames).toHaveLength(10);

  setPaused(true);
  published.mockClear();
  debugWs.frame('in', '{"type":"ping"}', { type: 'ping' });
  vi.advanceTimersByTime(PUBLISH_MS);
  expect(published).not.toHaveBeenCalled();
  expect(useDebugCapture.getState().view.frames).toHaveLength(10);
  setPaused(false);
  expect(useDebugCapture.getState().view.frames).toHaveLength(11);

  clearCapture();
  expect(useDebugCapture.getState().view.frames).toEqual([]);
  unsubscribe();
});

test('a call records the body it sent', () => {
  setDebugEnabled(true);
  debugCall()?.request('POST', '/api/chat/1/messages', { content: 'Hi' });
  expect(snapshot().calls[0]).toMatchObject({ method: 'POST', request: { content: 'Hi' } });
});

test("a stream's done event gives llama-server's measures of the reply", () => {
  setDebugEnabled(true);
  const stream = debugCall(true);
  const stats = {
    ttftMs: 120,
    promptTokens: 30,
    cachedTokens: 10,
    genTokens: 200,
    ppTps: 900.5,
    tgTps: 45.2,
    draftN: null,
    draftAccepted: null,
    durationMs: 4500,
  };
  stream?.event({ type: 'delta', content: 'Hi' });
  expect(snapshot().streams[0]?.stream?.stats).toBeUndefined();
  stream?.event({ type: 'done', message: { id: 1, content: 'Hi', stats } });
  expect(snapshot().streams[0]?.stream?.stats).toEqual({
    ttftMs: 120,
    promptTokens: 30,
    cachedTokens: 10,
    genTokens: 200,
    ppTps: 900.5,
    tgTps: 45.2,
  });
});

test('layout shifts less than 1 s apart, within 5 s, make one session window', () => {
  let w = addShift(undefined, 0, 0.1);
  w = addShift(w, 900, 0.1);
  expect(w).toEqual({ start: 0, last: 900, value: 0.2 });
  // A gap of 1 s or more opens a new window.
  expect(addShift(w, 1900, 0.05)).toEqual({ start: 1900, last: 1900, value: 0.05 });
  // So does a window of 5 s, gaps or not.
  let long = addShift(undefined, 0, 0.01);
  for (const at of [800, 1600, 2400, 3200, 4000, 4800]) long = addShift(long, at, 0.01);
  expect(addShift(long, 5600, 0.3)).toEqual({ start: 5600, last: 5600, value: 0.3 });
});

test('the CLS is the worst session window, the total sums every shift', () => {
  setDebugEnabled(true);
  debugLayoutShift(0, 0.1);
  debugLayoutShift(500, 0.1);
  debugLayoutShift(3000, 0.15);
  expect(snapshot().perf.layoutShifts).toEqual({ count: 3, total: 0.35, worstWindow: 0.2 });
});

test('the largest paint, the frame samples and the files loaded are kept, bounded, and cleared', () => {
  setDebugEnabled(true);
  debugLcp(800, 'h1');
  debugLcp(1500, 'img');
  for (let i = 0; i < SAMPLES + 5; i++) debugFrameSample(60, i);
  debugResource({ at: 1, name: '/assets/a.js', type: 'script', transferBytes: 0, bytes: 20, ms: 1, cached: true });
  const view = snapshot();
  expect(view.perf.lcp).toEqual({ ms: 1500, element: 'img' });
  expect(view.perf.samples).toHaveLength(SAMPLES);
  expect(view.perf.samples.at(-1)).toMatchObject({ fps: 60, heap: SAMPLES + 4 });
  expect(view.resources).toMatchObject([{ name: '/assets/a.js', cached: true }]);
  clearCapture();
  expect(snapshot().perf.samples).toEqual([]);
  expect(snapshot().resources).toEqual([]);
});

test("a store's changed keys are those whose value is not the same one, its actions left out", () => {
  const shared = [1];
  const act = () => {};
  expect(changedKeys({ a: shared, b: 1, c: 'x', act }, { a: shared, b: 2, d: 'y', act: () => {} })).toEqual([
    'b',
    'c',
    'd',
  ]);
});

test('the store changes are kept by reference, bounded, with their rate, and cleared', () => {
  setDebugEnabled(true);
  const list = [1, 2];
  debugStoreChange('quiet', { saved: true }, { saved: false });
  debugStoreChange('s', { list, n: 1 }, { list: [], n: 1 });
  expect(snapshot().storeChanges[1]?.next.list).toBe(list);
  for (let i = 0; i < STORE_CHANGES + 5; i++) debugStoreChange('s', { n: i + 1 }, { n: i });
  const view = snapshot();
  // Each store keeps its own last changes: the quiet one's survives the noisy one's, and comes first (the oldest).
  expect(view.storeChanges).toHaveLength(STORE_CHANGES + 1);
  expect(view.storeChanges[0]).toMatchObject({ store: 'quiet', keys: ['saved'] });
  expect(view.storeChanges.filter((c) => c.store === 's')).toHaveLength(STORE_CHANGES);
  const noisy = view.storeStats.find((t) => t.store === 's');
  expect(noisy).toMatchObject({ changes: STORE_CHANGES + 6, noops: 0 });
  expect(noisy?.last).toBeTypeOf('number');
  clearCapture();
  expect(snapshot().storeChanges).toEqual([]);
  expect(snapshot().storeStats).toEqual([]);
});
