import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { copyDataDir, dataCopyOf } from './datadir.ts';
import { alive, startTime, terminate, undo } from './instance.ts';
import { EMPTY_STATE, runDir } from './run-dir.ts';
import { worktreeAddArgs } from './target.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).toReversed()) await c();
});

/** A process that stands for the server or Chromium. */
function sleeper(): ChildProcess & { pid: number } {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  if (child.pid === undefined) throw new Error('sleep did not spawn');
  const pid = child.pid;
  cleanups.push(() => terminate(pid, 0, 'SIGKILL').then(() => undefined));
  return Object.assign(child, { pid });
}

/** An API that fails every request, counting them. */
async function failingApi(): Promise<{ port: number; requests: () => number }> {
  let count = 0;
  const server: Server = createServer((_req, res) => {
    count++;
    res.writeHead(500, { 'content-type': 'application/json' }).end('{"_tag":"Boom","message":"boom"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { port: (server.address() as AddressInfo).port, requests: () => count };
}

function tempRun(port: number) {
  const run = runDir(`.undo-test-${String(process.pid)}-${String(cleanups.length)}`);
  mkdirSync(run.path, { recursive: true });
  writeFileSync(run.file('run.json'), JSON.stringify({ options: { host: '127.0.0.1', port } }));
  cleanups.push(() => rmSync(run.path, { recursive: true, force: true }));
  return run;
}

test('a failing step is reported and the server is still stopped', async () => {
  const api = await failingApi();
  const server = sleeper();
  const run = tempRun(api.port);
  run.writeState({
    ...EMPTY_STATE,
    serverPid: server.pid,
    serverStart: startTime(server.pid),
    conversations: [3],
    profileStarted: true,
    restoreDefaultProfile: { id: 8 },
  });
  const out = await undo(run);
  expect(api.requests()).toBeGreaterThan(0);
  expect(out.failed.length).toBeGreaterThan(0);
  expect(alive(server.pid)).toBe(false);
  expect(run.readState()).toEqual(EMPTY_STATE);
});

test('a pid reused by another process is neither signalled nor its port called', async () => {
  const api = await failingApi();
  const other = sleeper();
  const run = tempRun(api.port);
  const start = startTime(other.pid) ?? 0;
  run.writeState({
    ...EMPTY_STATE,
    serverPid: other.pid,
    serverStart: start - 1,
    chromePid: other.pid,
    chromeStart: start - 1,
    conversations: [3],
    profileStarted: true,
  });
  await undo(run);
  expect(api.requests()).toBe(0);
  expect(alive(other.pid)).toBe(true);
});

test('the worktree of a base and the copy of the data directory are removed, with no server left to call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profiling-undo-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'file.txt'), 'one\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'one');
  const worktree = join(root, 'base');
  execFileSync('git', worktreeAddArgs(worktree, git('rev-parse', 'HEAD'), repo), { stdio: 'ignore' });

  const api = await failingApi();
  const run = tempRun(api.port);
  copyDataDir(run, repo);
  run.writeState({ ...run.readState(), worktree });
  const out = await undo(run);
  expect(out.failed).toEqual([]);
  expect(out.done).toEqual([`removed the base worktree (${worktree})`, 'removed the copy of the data directory']);
  expect(existsSync(worktree)).toBe(false);
  expect(existsSync(dataCopyOf(run))).toBe(false);
  expect(git('worktree', 'list').split('\n')).toHaveLength(1);
  expect(api.requests()).toBe(0);
  expect(run.readState()).toEqual(EMPTY_STATE);
});

test('a worktree that cannot be removed is reported, and the rest is still undone', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'profiling-undo-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  const api = await failingApi();
  const run = tempRun(api.port);
  copyDataDir(run, folder);
  run.writeState({ ...run.readState(), worktree: folder });
  const out = await undo(run);
  expect(out.failed).toHaveLength(1);
  expect(out.failed[0]).toContain('could not remove the base worktree');
  expect(existsSync(folder)).toBe(true);
  expect(existsSync(dataCopyOf(run))).toBe(false);
});
