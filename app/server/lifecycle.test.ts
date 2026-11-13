// The production build's lifecycle (`app/.output`, built once by the server project's globalSetup): how it stops on a
// signal with the UI open and a reply streaming, and how it fails when its port is taken.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, expect, test } from 'vitest';
import { ConversationsRepo } from './lib/db/conversations';
import { openDb } from './lib/db/open';
import { ProfilesRepo } from './lib/db/profiles';
import { SettingsRepo } from './lib/db/settings';
import { writeGguf } from './lib/models/gguf.fixture';
import { freePort, LAUNCHER, launch } from './lib/testing/launch';
import { tempDir } from './lib/testing/tempDir';

const FAKE_SERVER = resolve(import.meta.dirname, '../../testdata/fake/fake-llama-server');
const dirs: { [Symbol.dispose](): void }[] = [];
afterAll(() => {
  for (const d of dirs) d[Symbol.dispose]();
});

/** A data dir whose settings run the fake llama-server, with one profile on a tiny GGUF. */
async function seeded(): Promise<{ dataDir: string; profileId: number }> {
  const dir = tempDir('lw-lifecycle-');
  dirs.push(dir);
  const model = join(dir.path, 'models/m.gguf');
  mkdirSync(join(dir.path, 'models'));
  await writeGguf(
    model,
    { 'general.architecture': { type: 'string', value: 'llama' }, 'llama.block_count': { type: 'u32', value: 1 } },
    [{ name: 'token_embd.weight', shape: [8, 4], bytes: 128 }],
  );
  using db = openDb(join(dir.path, 'llama-webui.sqlite'));
  new SettingsRepo(db).patch({ binary: FAKE_SERVER, modelsDir: join(dir.path, 'models'), port: await freePort() });
  const profile = new ProfilesRepo(db).create({ name: 'fake', model, args: [], env: {} });
  return { dataDir: dir.path, profileId: profile.id };
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('SIGTERM with the UI open and a reply streaming stops in under 2 s', async () => {
  const { dataDir, profileId } = await seeded();
  // The fake llama-server inherits the environment: 2 s between chat chunks, the reply still streams at SIGTERM.
  const app = await launch({ dataDir, env: { FAKE_CHAT_DELAY_MS: '2000' } });
  const json = { 'content-type': 'application/json' };
  const post = (path: string, body: unknown) =>
    fetch(`${app.base}${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) });

  expect((await post('/api/server/start', { profileId })).status).toBe(202);
  let llamaPid = 0;
  for (let i = 0; i < 100 && !llamaPid; i++) {
    const { state } = (await (await fetch(`${app.base}/api/server/state`)).json()) as {
      state: { kind: string; pid?: number };
    };
    if (state.kind === 'ready') llamaPid = state.pid ?? 0;
    else await sleep(100);
  }
  expect(llamaPid).toBeGreaterThan(0);

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
