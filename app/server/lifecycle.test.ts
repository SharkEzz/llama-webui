// The production build's lifecycle (`app/.output`, built once by the server project's globalSetup): how it stops on a
// signal with the UI open and a reply streaming, how it fails when its port is taken, and its HTTP cache headers.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, describe, expect, test } from 'vitest';
import { ConversationsRepo } from './lib/db/conversations';
import { openDb } from './lib/db/open';
import { LAUNCHER, launch } from './lib/testing/launch';
import { isAlive, seedDataDir, startLlama } from './lib/testing/seed';
import { tempDir } from './lib/testing/tempDir';

const dirs: { [Symbol.dispose](): void }[] = [];
afterAll(() => {
  for (const d of dirs) d[Symbol.dispose]();
});

async function seeded(): Promise<{ dataDir: string; profileId: number }> {
  const dir = tempDir('lw-lifecycle-');
  dirs.push(dir);
  return { dataDir: dir.path, ...(await seedDataDir(dir.path)) };
}

test('SIGTERM with the UI open and a reply streaming stops in under 2 s', async () => {
  const { dataDir, profileId } = await seeded();
  // The fake llama-server inherits the environment: 2 s between chat chunks, the reply still streams at SIGTERM.
  const app = await launch({ dataDir, env: { FAKE_CHAT_DELAY_MS: '2000' } });
  const json = { 'content-type': 'application/json' };
  const post = (path: string, body: unknown) =>
    fetch(`${app.base}${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) });

  const llamaPid = await startLlama(app.base, profileId);

  const ws = new WebSocket(`${app.base.replace('http', 'ws')}/ws`);
  const wsClosed = new Promise<number>((done) => ws.addEventListener('close', (e) => done(e.code)));
  await new Promise((done) => ws.addEventListener('message', done, { once: true }));

  const conversation = (await (await post('/api/chat', { profileId })).json()) as { id: number };
  const stream = await post(`/api/chat/${conversation.id}/messages`, { content: 'hi' });
  expect(stream.headers.get('content-type')).toContain('text/event-stream');
  const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
  await reader.read(); // the first event: the reply has started
  const sseEnded = (async () => {
    try {
      while (!(await reader.read()).done);
      return true;
    } catch {
      return false;
    }
  })();

  const t0 = performance.now();
  app.proc.kill('SIGTERM');
  const exitCode = await app.exited;
  const elapsedMs = performance.now() - t0;

  expect(elapsedMs).toBeLessThan(2000);
  expect(exitCode).toBe(0);
  expect(await wsClosed).toBe(1001);
  expect(await sseEnded).toBe(true);
  expect(isAlive(llamaPid)).toBe(false);
  using db = openDb(join(dataDir, 'llama-webui.sqlite'));
  const messages = new ConversationsRepo(db).messages(conversation.id);
  expect(messages.at(-1)?.status).toBe('stopped');
}, 30_000);

test('a second instance on a taken port exits 1', async () => {
  const first = await launch({ dataDir: (await seeded()).dataDir });
  try {
    const { dataDir } = await seeded();
    const second = spawn(process.execPath, [LAUNCHER, '--port', String(first.port), '--data-dir', dataDir], {
      cwd: dataDir,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    second.stderr.on('data', (c) => {
      stderr += c;
    });
    const exited = new Promise<number | null>((done) => second.once('exit', done));
    const code = await Promise.race([exited, sleep(5000, 'timeout', { ref: false })]);
    if (code === 'timeout') second.kill('SIGKILL');
    expect(code).toBe(1);
    expect(stderr).toMatch(new RegExp(`${first.port}|EADDRINUSE`));
  } finally {
    await first[Symbol.asyncDispose]();
  }
}, 30_000);

test("a second instance on the same port and data dir leaves the first one's data alone", async () => {
  const { dataDir, profileId } = await seeded();
  // The stub monitor starts at once: without a port check first, the second instance's startup would run before its
  // listen fails, and mark the first one's streaming reply "stopped".
  const env = { FAKE_CHAT_DELAY_MS: '2000', LLAMA_WEBUI_TEST_MONITOR: 'stub' };
  await using first = await launch({ dataDir, env });
  await startLlama(first.base, profileId);
  const post = (path: string, body: unknown) =>
    fetch(`${first.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const conversation = (await (await post('/api/chat', { profileId })).json()) as { id: number };
  const stream = await post(`/api/chat/${conversation.id}/messages`, { content: 'hi' });
  const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
  await reader.read(); // the reply has started
  const full: Record<string, string | undefined> = { ...process.env, ...env };
  for (const k of ['CI', 'TEST', 'NODE_ENV']) delete full[k];
  const second = spawn(process.execPath, [LAUNCHER, '--port', String(first.port), '--data-dir', dataDir], {
    cwd: dataDir,
    env: full,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  second.stderr.on('data', (c) => {
    stderr += c;
  });
  const code = await new Promise<number | null>((done) => second.once('exit', done));
  using db = openDb(join(dataDir, 'llama-webui.sqlite'));
  expect(new ConversationsRepo(db).messages(conversation.id).at(-1)?.status).toBe('streaming');
  expect(code).toBe(1);
  expect(stderr).not.toContain('[llama-webui] ready');
  await reader.cancel();
}, 30_000);

describe('HTTP cache', () => {
  test('pages are revalidated, hashed assets are immutable, the API sets no cache header', async () => {
    await using app = await launch({ dataDir: (await seeded()).dataDir });
    const get = (path: string) => fetch(`${app.base}${path}`);
    const page = await get('/');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const asset = (await page.text()).match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    expect(asset).toBeDefined();
    expect((await get('/chat/12')).headers.get('cache-control')).toBe('no-cache');
    expect((await get(asset as string)).headers.get('cache-control')).toMatch(/immutable/);
    expect((await get('/api/health')).headers.get('cache-control')).toBeNull();
  }, 30_000);
  test("a missing asset is h3's own 404, not a 500 (a stale tab after an upgrade)", async () => {
    await using app = await launch({ dataDir: (await seeded()).dataDir });
    const res = await fetch(`${app.base}/assets/missing-abcd1234.js`);
    expect(res.status).toBe(404);
    expect(app.stderr()).not.toMatch(/status: 404/);
  }, 30_000);
});
