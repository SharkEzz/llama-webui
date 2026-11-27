// The smoke test of the build (scripts/smoke.ts), run against the build of this run (app/server/testing/build.ts).
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';

const SMOKE = join(import.meta.dirname, 'smoke.ts');
const ROOT = join(import.meta.dirname, '..');

// Each run gets this folder as its TMPDIR: what the smoke leaves behind is in it.
const tmps: string[] = [];
afterAll(() => {
  for (const dir of tmps) rmSync(dir, { recursive: true, force: true });
});
const freshTmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-test-'));
  tmps.push(dir);
  return dir;
};

/** Starts the smoke with `args`; `ended` gives its exit code (or signal) and its stderr. */
function smoke(args: string[], tmp: string) {
  const child = spawn(process.execPath, [SMOKE, ...args], {
    cwd: ROOT,
    env: { ...process.env, TMPDIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  const ended = new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
    child.once('exit', (code) => done({ code, stdout, stderr })),
  );
  return { child, ended };
}

test('--expect-version fails unless the build reports exactly that version (#120)', async () => {
  const wrong = await smoke(['--expect-version', 'v0.0.0-not-this-build'], freshTmp()).ended;
  expect(wrong.code).toBe(1);
  const reported = /smoke: the build reports (\S+), expected v0\.0\.0-not-this-build/.exec(wrong.stderr)?.[1];
  expect(reported, wrong.stderr).toBeDefined();

  const right = await smoke(['--expect-version', reported!], freshTmp()).ended;
  expect(right.code, right.stderr).toBe(0);
  expect(right.stdout).toContain(`smoke: ok (`);
}, 30_000);

test('SIGTERM stops the server and removes the temporary directories (#120)', async () => {
  const tmp = freshTmp();
  const run = smoke([], tmp);
  // The data directory exists once the server is spawned: stop the smoke while it waits for it.
  await vi.waitFor(() => expect(readdirSync(tmp).some((d) => d.startsWith('lw-smoke-'))).toBe(true), {
    timeout: 10_000,
    interval: 10,
  });
  run.child.kill('SIGTERM');
  const { code, stderr } = await run.ended;
  expect(code, stderr).toBe(143);
  expect(stderr).toContain('smoke: SIGTERM, stopping');
  expect(readdirSync(tmp)).toEqual([]);
}, 30_000);
