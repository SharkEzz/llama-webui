import { expect, test } from 'vitest';
import { externalWatcher } from './external';

test('no external server is detected while a benchmark owns the port', async () => {
  let detected = 0;
  const check = externalWatcher({
    supervisor: {
      state: { kind: 'idle' },
      detectExternal: async () => {
        detected++;
        return true;
      },
      recheckExternal: async () => {},
    },
    ports: () => [8080],
    paused: () => true,
  });
  await check();
  expect(detected).toBe(0);
});

test('after a crash, the settings port and the last profile port are watched (#39, #28)', async () => {
  const probed: number[] = [];
  const check = externalWatcher({
    supervisor: {
      state: { kind: 'crashed', profile: 'p', profileId: 1, exitCode: 1, signal: null, at: 0 },
      detectExternal: async (port) => {
        probed.push(port);
        return false;
      },
      recheckExternal: async () => {},
    },
    ports: () => [8080, 9090, 8080, undefined],
    paused: () => false,
  });
  await check();
  expect(probed).toEqual([8080, 9090]);
});
