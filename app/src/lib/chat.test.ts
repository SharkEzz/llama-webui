import { Api, type ChatEvent, type ChatMessage, type ConversationDetail } from '@llama-webui/shared';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeCall, makeCallStream } from './api';
import { makeChatStore } from './chat';

// The browser resolves the client's relative URLs against the page, and paints frames; Vitest's node environment
// has neither.
beforeEach(() => {
  vi.stubGlobal('location', new URL('http://llama-webui.test/'));
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0));
  vi.stubGlobal('cancelAnimationFrame', (t: ReturnType<typeof setTimeout>) => clearTimeout(t));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const message = (m: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage => ({
  conversationId: 1,
  content: '',
  reasoning: '',
  status: 'done',
  error: null,
  stats: null,
  model: null,
  createdAt: 1,
  ...m,
});

const detail = (id: number, messages: ReadonlyArray<ChatMessage>, live: boolean): ConversationDetail => ({
  id,
  title: 'New conversation',
  profileId: null,
  modelPath: null,
  systemPrompt: '',
  sampling: {},
  thinking: false,
  createdAt: 1,
  updatedAt: 1,
  messages,
  live,
});

const user = message({ id: 1, role: 'user', content: 'Hi' });
const streaming = message({ id: 2, role: 'assistant', status: 'streaming' });
const saved = message({ id: 2, role: 'assistant', content: 'Hello', status: 'stopped' });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const event = (e: ChatEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/** A reply's body: `events` one per read, then it ends, breaks off with `end`, or stays open (`'open'`). */
const sse = (events: ReadonlyArray<ChatEvent>, end: 'close' | 'open' | Error = 'close') => {
  const left = events.map(event);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = left.shift();
      if (chunk !== undefined) controller.enqueue(new TextEncoder().encode(chunk));
      else if (end === 'close') controller.close();
      else if (end !== 'open') controller.error(end);
      else return new Promise<void>(() => {});
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

/**
 * The store on a fake server: `routes` answers `METHOD /path` (a list answers once per request, its last answer
 * after), and `seen` records what was asked, with each request's signal.
 */
function server(routes: Record<string, Response | (() => Response) | ReadonlyArray<() => Response>>) {
  const seen: Array<{ route: string; signal: AbortSignal | null | undefined }> = [];
  const asked = new Map<string, number>();
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const route = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
    seen.push({ route, signal: init?.signal });
    const n = asked.get(route) ?? 0;
    asked.set(route, n + 1);
    const answer = routes[route];
    if (answer === undefined) return Promise.resolve(json(404, { _tag: 'RouteNotFound', message: 'Unknown route' }));
    if (answer instanceof Response) return Promise.resolve(answer.clone());
    if (typeof answer === 'function') return Promise.resolve(answer());
    const next = answer[Math.min(n, answer.length - 1)];
    return next === undefined ? Promise.reject(new TypeError('no answer')) : Promise.resolve(next());
  }) as typeof fetch;
  const store = makeChatStore({ call: makeCall(Api, fetchImpl), callStream: makeCallStream(Api, fetchImpl) });
  return { store, routes: () => seen.map((s) => s.route), seen };
}

test('a follow answered 204 (the reply ended meanwhile) rereads the conversation', async () => {
  const { store, routes } = server({
    'GET /api/chat/1': [
      () => json(200, detail(1, [user, streaming], true)),
      () => json(200, detail(1, [user, saved], false)),
    ],
    'GET /api/chat/1/stream': () => new Response(null, { status: 204 }),
  });
  await store.getState().open(1);
  await vi.waitFor(() => expect(store.getState().current?.live).toBe(false));
  expect(routes()).toEqual(['GET /api/chat/1', 'GET /api/chat/1/stream', 'GET /api/chat/1']);
  expect(store.getState().current?.messages).toEqual([user, saved]);
  expect(store.getState().streaming).toBeNull();
});

test('a reply that ends without done (the server restarted) rereads the conversation', async () => {
  const { store, routes } = server({
    'GET /api/chat/1': [() => json(200, detail(1, [], false)), () => json(200, detail(1, [user, saved], false))],
    'POST /api/chat/1/messages': () =>
      sse([
        { type: 'start', user, assistant: streaming },
        { type: 'delta', content: 'Hello' },
      ]),
  });
  await store.getState().open(1);
  await store.getState().send('Hi');
  await vi.waitFor(() => expect(store.getState().current?.messages).toEqual([user, saved]));
  expect(routes()).toEqual(['GET /api/chat/1', 'POST /api/chat/1/messages', 'GET /api/chat/1']);
  expect(store.getState().streaming).toBeNull();
});

test('a reply whose connection breaks off (ApiUnreachable) rereads the conversation, without a toast', async () => {
  const shown = vi.spyOn(toast, 'error');
  const { store, routes } = server({
    'GET /api/chat/1': [() => json(200, detail(1, [], false)), () => json(200, detail(1, [user, saved], false))],
    'POST /api/chat/1/messages': () =>
      sse([{ type: 'start', user, assistant: streaming }], new TypeError('terminated')),
  });
  await store.getState().open(1);
  await store.getState().send('Hi');
  await vi.waitFor(() => expect(store.getState().current?.messages).toEqual([user, saved]));
  expect(routes()).toEqual(['GET /api/chat/1', 'POST /api/chat/1/messages', 'GET /api/chat/1']);
  expect(store.getState().streaming).toBeNull();
  expect(shown).not.toHaveBeenCalled();
});

test('a send the server refuses (409) shows its message and rereads nothing', async () => {
  const shown = vi.spyOn(toast, 'error');
  const { store, routes } = server({
    'GET /api/chat/1': () => json(200, detail(1, [], false)),
    'POST /api/chat/1/messages': () =>
      json(409, { _tag: 'ReplyInProgress', message: 'A reply is already in progress in this conversation' }),
  });
  await store.getState().open(1);
  await store.getState().send('Hi');
  expect(shown).toHaveBeenCalledExactlyOnceWith('A reply is already in progress in this conversation');
  expect(routes()).toEqual(['GET /api/chat/1', 'POST /api/chat/1/messages']);
  expect(store.getState().current).toEqual(detail(1, [], false));
  expect(store.getState().streaming).toBeNull();
});

test('a reply left for another conversation is aborted, and neither rereads nor shows anything', async () => {
  const shown = vi.spyOn(toast, 'error');
  const { store, routes, seen } = server({
    'GET /api/chat/1': () => json(200, detail(1, [], false)),
    'GET /api/chat/2': () => json(200, detail(2, [], false)),
    'POST /api/chat/1/messages': () => sse([{ type: 'start', user, assistant: streaming }], 'open'),
  });
  await store.getState().open(1);
  const sending = store.getState().send('Hi');
  await vi.waitFor(() => expect(store.getState().streaming?.conversationId).toBe(1));
  await store.getState().open(2);
  await sending;
  expect(routes()).toEqual(['GET /api/chat/1', 'POST /api/chat/1/messages', 'GET /api/chat/2']);
  expect(seen[1]?.signal?.aborted).toBe(true);
  expect(store.getState().current?.id).toBe(2);
  expect(store.getState().streaming).toBeNull();
  expect(shown).not.toHaveBeenCalled();
});
