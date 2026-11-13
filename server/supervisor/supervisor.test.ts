import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { LogBuffer } from '../logs/buffer';
import type { BuiltCommand } from './args';
import { Supervisor } from './supervisor';

const FAKE = resolve(import.meta.dirname, '../../testdata/fake/fake-llama-server');

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

/** The timers that keep the process alive (an unref'd one is not listed). */
const liveTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

test('stop() leaves no timer keeping the process alive once llama-server has exited', async () => {
  const port = await freePort();
  const logs = new LogBuffer(100);
  const supervisor = new Supervisor({ logs, healthPollMs: 20 });
  const cmd: BuiltCommand = {
    argv: [FAKE, '-m', 'm.gguf', '--host', '127.0.0.1', '--port', String(port)],
    display: 'fake-llama-server',
    cwd: import.meta.dirname,
    env: { PATH: process.env.PATH ?? '' },
    host: '127.0.0.1',
    port,
    profileName: 'fake',
    profileId: 1,
  };
  await supervisor.start(cmd);
  for (let i = 0; i < 250 && supervisor.state.kind !== 'ready'; i++) await sleep(20);
  expect(supervisor.state.kind).toBe('ready');
  // Ready: the health poll is cleared, the timers running now are not the supervisor's.
  const before = liveTimers();
  await supervisor.stop();
  // The SIGKILL deadline (5 s by default) must not outlive the stop: it would hold the process open on shutdown.
  expect(liveTimers()).toBe(before);
}, 15_000);
