import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { alive, startTime, terminate, undo } from './instance.ts';
import { EMPTY_STATE, runDir } from './run-dir.ts';

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
