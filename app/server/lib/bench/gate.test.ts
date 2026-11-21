import type { ServerState } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import { LogBuffer } from '../logs/buffer';
import type { BuiltCommand } from '../supervisor/args';
import { BenchGate, type ServerControl } from './gate';

const cmd = (display: string): BuiltCommand => ({
  argv: ['llama-server'],
  display,
  cwd: '/',
  env: {},
  host: '127.0.0.1',
  port: 8080,
  profileName: 'A',
  profileId: 1,
});

function fakeServer() {
  const started: string[] = [];
  let state: ServerState = {
    kind: 'ready',
    profile: 'A',
    profileId: 1,
    pid: 1,
    host: '127.0.0.1',
    port: 8080,
    since: 0,
  };
  const server: ServerControl = {
    get state() {
      return state;
    },
    lastCommand: cmd('before the benchmark'),
    stop: async () => {
      state = { kind: 'idle' };
    },
    start: async (c) => {
      started.push(c.display);
    },
  };
  return { server, started };
}

test('the server stopped for a benchmark restarts with the profile as it is now (#39)', async () => {
  const { server, started } = fakeServer();
  const gate = new BenchGate({ server, logs: new LogBuffer(10) });
  await gate.acquire({ stopServer: true });
  await gate.ready();
  await gate.release((stopped) => (stopped.profileId === 1 ? cmd('edited during the benchmark') : null));
  expect(started).toEqual(['edited during the benchmark']);
});

test('without a rebuilt command (profile deleted), the recorded one is used (#39)', async () => {
  const { server, started } = fakeServer();
  const gate = new BenchGate({ server, logs: new LogBuffer(10) });
  await gate.acquire({ stopServer: true });
  await gate.release(() => null);
  expect(started).toEqual(['before the benchmark']);
});
