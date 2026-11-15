import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const FIXTURES = resolve(import.meta.dirname, '../testing/fixtures');

/** A fixture in its own Node process: its output so far, a wait for a line, and its exit. */
function start(fixture: string, args: string[] = []) {
  const proc = spawn(process.execPath, [resolve(FIXTURES, fixture), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const waiters: Array<() => void> = [];
  proc.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const w of waiters) w();
  });
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    proc.once('exit', (code, signal) => done({ code, signal })),
  );
  const line = (text: string) =>
    new Promise<void>((done) => {
      const check = () => stdout.split('\n').includes(text) && done();
      waiters.push(check);
      check();
    });
  return { proc, exited, line, stdout: () => stdout, stderr: () => stderr };
}

test('SIGTERM undoes the app and exits 0', async () => {
  const app = start('slowStop.ts', ['100']);
  await app.line('ready');
  app.proc.kill('SIGTERM');
  expect(await app.exited).toEqual({ code: 0, signal: null });
  expect(app.stdout()).toContain('undone');
  expect(app.stderr()).toBe('');
});

test('a second signal while stopping exits at once', async () => {
  const app = start('slowStop.ts', ['10000']);
  await app.line('ready');
  const t0 = performance.now();
  app.proc.kill('SIGTERM');
  setTimeout(() => app.proc.kill('SIGTERM'), 200);
  const exit = await app.exited;
  expect(performance.now() - t0).toBeLessThan(1000);
  // The stop was cut short: its finalizer never finished.
  expect(exit).toEqual({ code: 130, signal: null });
  expect(app.stdout()).not.toContain('undone');
});

test('a failure exits 1 with its message', async () => {
  const app = start('fails.ts');
  expect(await app.exited).toEqual({ code: 1, signal: null });
  expect(app.stderr()).toBe('llama-webui: the fixture is broken on purpose\n');
});
