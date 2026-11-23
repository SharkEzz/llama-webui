import { Api, type LogLine } from '@llama-webui/shared';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { create } from 'zustand';
import { makeCall } from './api';
import { makeLogs } from './logs';
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

const line = (seq: number): LogLine => ({ seq, text: `line ${seq}`, level: 'info', kind: 'other' });

/** The store on a fake server holding `held` lines of boot `boot`; `asked` lists the `since` of each read. */
function setup(status: WsStatus, held: LogLine[] = [line(0), line(1)]) {
  const asked: number[] = [];
  const fetchImpl = ((input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== '/api/logs')
      return Promise.resolve(json(404, { _tag: 'RouteNotFound', message: 'Unknown route' }));
    const since = Number(url.searchParams.get('since') ?? '0');
    asked.push(since);
    const lines = held.filter((l) => l.seq >= since);
    return Promise.resolve(json(200, { lines, seq: held.length, bootId: 'boot-1' }));
  }) as typeof fetch;
  const ws = create<{ status: WsStatus }>()(() => ({ status }));
  const logs = makeLogs({ call: makeCall(Api, fetchImpl), ws });
  return { logs, ws, asked };
}

/** Lets the requests in flight answer. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the logs are read only once a page shows them, and the messages before are ignored', async () => {
  const { logs, ws, asked } = setup('connecting');
  ws.setState({ status: 'open' });
  logs.hello('boot-1');
  logs.lines([line(2)]);
  ws.setState({ status: 'closed' });
  ws.setState({ status: 'open' });
  await settle();
  expect(asked).toEqual([]);
  expect(logs.store.getState().lines).toEqual([]);
});

test('a page shown with the channel open reads the whole ring at once, then follows the messages', async () => {
  const { logs, asked } = setup('open');
  logs.follow();
  await settle();
  expect(asked).toEqual([0]);
  expect(logs.store.getState()).toMatchObject({ lines: [line(0), line(1)], seq: 2, bootId: 'boot-1' });
  logs.lines([line(2)]);
  expect(logs.store.getState().seq).toBe(3);
});

test('a cold load of the page reads the ring when the channel opens, the missed lines on each reconnect', async () => {
  const { logs, ws, asked } = setup('connecting');
  logs.follow();
  await settle();
  expect(asked).toEqual([]);
  ws.setState({ status: 'open' });
  await settle();
  expect(asked).toEqual([0]);
  ws.setState({ status: 'closed' });
  ws.setState({ status: 'open' });
  await settle();
  expect(asked).toEqual([0, 2]);
});

test('a second page that shows the logs reads nothing more', async () => {
  const { logs, asked } = setup('open');
  logs.follow();
  logs.follow();
  await settle();
  expect(asked).toEqual([0]);
});
