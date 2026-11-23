import { Api, type ModelPlacement } from '@llama-webui/shared';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { create } from 'zustand';
import { makeCall } from './api';
import { makeTopology } from './topology';
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

const GRAPH = {
  nodes: [{ id: 'cpu', kind: 'cpu', label: 'CPU', detail: {} }],
  links: [],
  at: 1,
};

const PLACEMENT: ModelPlacement = { launchSeq: 3, layers: { offloaded: 49, total: 49 }, buffers: [] };

/** The store on a fake server and a push channel of its own; `reads` counts the requests of the graph. */
function setup(status: WsStatus, reply: () => Response = () => json(200, { graph: GRAPH, placement: null })) {
  let reads = 0;
  const fetchImpl = ((input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== '/api/topology')
      return Promise.resolve(json(404, { _tag: 'RouteNotFound', message: 'Unknown route' }));
    reads++;
    return Promise.resolve(reply());
  }) as typeof fetch;
  const ws = create<{ status: WsStatus }>()(() => ({ status }));
  const topology = makeTopology({ call: makeCall(Api, fetchImpl), ws });
  return { topology, ws, reads: () => reads };
}

/** Lets the requests in flight answer. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the graph is read only once a page watches it', async () => {
  const { topology, ws, reads } = setup('connecting');
  ws.setState({ status: 'open' });
  ws.setState({ status: 'closed' });
  ws.setState({ status: 'open' });
  await settle();
  expect(reads()).toBe(0);
  expect(topology.store.getState().graph).toBeNull();
});

test('a cold load of the page reads the graph once, when the channel opens', async () => {
  const { topology, ws, reads } = setup('connecting');
  const stop = topology.watch();
  await settle();
  expect(reads()).toBe(0);
  ws.setState({ status: 'open' });
  await settle();
  expect(reads()).toBe(1);
  expect(topology.store.getState().graph).toEqual(GRAPH);
  stop();
});

test('a page shown with the channel open reads the graph at once, and again on each reconnect', async () => {
  const { topology, ws, reads } = setup('open');
  const stop = topology.watch();
  await settle();
  expect(reads()).toBe(1);
  ws.setState({ status: 'closed' });
  await settle();
  expect(reads()).toBe(1);
  ws.setState({ status: 'open' });
  await settle();
  expect(reads()).toBe(2);
  stop();
  ws.setState({ status: 'closed' });
  ws.setState({ status: 'open' });
  await settle();
  expect(reads()).toBe(2);
});

test('a first connection that fails still reads the graph, which reports the failure', async () => {
  const { topology, ws, reads } = setup('connecting', () => json(500, { _tag: 'Internal', message: 'x' }));
  const stop = topology.watch();
  ws.setState({ status: 'closed' });
  await settle();
  expect(reads()).toBe(1);
  expect(topology.store.getState().error).toBe(true);
  ws.setState({ status: 'open' });
  await settle();
  expect(reads()).toBe(2);
  stop();
});

test('a placement message received while the graph is read wins over the reply', async () => {
  const { topology } = setup('open');
  topology.receive(PLACEMENT);
  expect(topology.store.getState().placement).toEqual(PLACEMENT);
  const stop = topology.watch();
  topology.receive(PLACEMENT);
  await settle();
  expect(topology.store.getState().graph).toEqual(GRAPH);
  expect(topology.store.getState().placement).toEqual(PLACEMENT);
  stop();
});
