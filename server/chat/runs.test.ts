import { setTimeout as sleep } from 'node:timers/promises';
import type { ChatEvent } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import { ConversationsRepo } from '../db/conversations';
import { openDb } from '../db/open';
import { ChatRuns } from './runs';

const enc = new TextEncoder();
const chunk = (delta: Record<string, string>, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta }], ...extra })}\n\n`;
const TIMINGS = { prompt_n: 10, prompt_per_second: 200, predicted_n: 3, predicted_per_second: 51.23 };
const tick = () => sleep(5);

/** A fake llama-server: the test pushes the stream chunks one by one. */
function setup() {
  const repo = new ConversationsRepo(openDb(':memory:'));
  const conv = repo.create({ profileId: null, modelPath: '/m.gguf' });
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  let body: Record<string, unknown> = {};
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    signal = init!.signal!;
    body = JSON.parse(String(init!.body));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
      },
    });
    signal.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError')));
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const runs = new ChatRuns({
    repo,
    target: () => ({ host: null, port: 8080, profileId: null, modelPath: '/m.gguf' }),
    fetch: fetchFn,
    flushMs: 0,
  });
  return {
    repo,
    conv,
    runs,
    push: async (s: string) => {
      ctl.enqueue(enc.encode(s));
      await tick();
    },
    end: () => ctl.close(),
    signal: () => signal,
    body: () => body,
  };
}

const answer = (repo: ConversationsRepo, id: number) => repo.messages(id).find((m) => m.role === 'assistant')!;

test('a run keeps going and is saved when its listener leaves', async () => {
  const t = setup();
  const run = t.runs.send(t.conv.id, 'Hi there');
  const events: ChatEvent[] = [];
  const leave = run.subscribe((e) => events.push(e));
  await tick();
  await t.push(chunk({ reasoning_content: 'Hmm.' }));
  leave();
  await t.push(chunk({ content: 'Hello' }));
  await t.push(chunk({ content: '!' }));
  await t.push(chunk({}, { timings: TIMINGS }));
  await t.push('data: [DONE]\n\n');
  t.end();
  await run.done;
  expect(events.map((e) => e.type)).toEqual(['start', 'delta']);
  const a = answer(t.repo, t.conv.id);
  expect([a.status, a.content, a.reasoning]).toEqual(['done', 'Hello!', 'Hmm.']);
  expect(a.stats?.tgTps).toBe(51.23);
  expect(a.stats?.ttftMs).not.toBeNull();
  expect(t.repo.conversation(t.conv.id)!.title).toBe('Hi there');
  expect(t.runs.live(t.conv.id)).toBeUndefined();
});

test('stop saves the partial answer as stopped', async () => {
  const t = setup();
  const run = t.runs.send(t.conv.id, 'Hi');
  await tick();
  await t.push(chunk({ content: 'Hel' }));
  expect(t.runs.stop(t.conv.id)).toBe(true);
  await run.done;
  const a = answer(t.repo, t.conv.id);
  expect([a.status, a.content]).toEqual(['stopped', 'Hel']);
  expect(t.signal().aborted).toBe(true);
});

test('a late subscriber gets what was already written', async () => {
  const t = setup();
  const run = t.runs.send(t.conv.id, 'Hi');
  await tick();
  await t.push(chunk({ content: 'Hel' }));
  await t.push(chunk({ content: 'lo' }));
  const events: ChatEvent[] = [];
  run.subscribe((e) => events.push(e));
  await t.push(chunk({ content: '!' }));
  t.end();
  await run.done;
  expect(events[0]!.type).toBe('start');
  expect(events[1]).toEqual({ type: 'delta', content: 'Hello' });
  expect(events[2]).toEqual({ type: 'delta', content: '!' });
  expect(events.at(-1)!.type).toBe('done');
});

test('a stream that ends without [DONE] or breaks is an error that keeps the partial answer', async () => {
  const t = setup();
  const run = t.runs.send(t.conv.id, 'Hi');
  await tick();
  await t.push(chunk({ content: 'Hel' }));
  t.end();
  await run.done;
  const a = answer(t.repo, t.conv.id);
  expect([a.status, a.content]).toEqual(['error', 'Hel']);
  expect(a.error).toBe('llama-server cut the reply short (stopped or crashed)');
});

test('dispose emits done(stopped) to listeners, so their streams close', async () => {
  const t = setup();
  const run = t.runs.send(t.conv.id, 'Hi');
  const events: ChatEvent[] = [];
  run.subscribe((e) => events.push(e));
  await tick();
  await t.push(chunk({ content: 'Hel' }));
  t.runs.dispose();
  const last = events.at(-1)!;
  expect(last.type).toBe('done');
  expect(last.type === 'done' && [last.message.status, last.message.content]).toEqual(['stopped', 'Hel']);
  expect(answer(t.repo, t.conv.id).status).toBe('stopped');
});
