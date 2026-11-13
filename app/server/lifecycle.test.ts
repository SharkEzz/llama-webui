// The production build's lifecycle (`app/.output`, built once by the server project's globalSetup): how it stops on a
// signal with the UI open and a reply streaming, and how it fails when its port is taken.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, expect, test } from 'vitest';
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
