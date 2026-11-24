import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  clearCapture,
  debugCall,
  debugNavigation,
  debugRender,
  debugWs,
  markErrorsSeen,
  PUBLISH_MS,
  rate,
  Ring,
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
  const view = snapshot();
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
