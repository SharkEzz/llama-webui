import { createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
import { serverLink } from './devServer.ts';

/** A port nothing listens on, on 127.0.0.1. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((closed) => server.close(closed));
  return port;
}

interface Listener {
  /** How many connections it accepted. */
  readonly accepted: () => number;
  /** Stops listening and cuts its connections, as a server that exits does. */
  readonly stop: () => Promise<void>;
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Something that accepts connections on `port`, stopped with the test. */
async function listen(port: number): Promise<Listener> {
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server: Server = createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((listening) => server.listen(port, '127.0.0.1', listening));
  const stop = async () => {
    if (!server.listening) return;
    const closed = new Promise((done) => server.close(done));
    for (const socket of sockets) socket.destroy();
    await closed;
  };
  cleanups.push(stop);
  return { accepted: () => accepted, stop };
}

/** A link to `port`, closed with the test. */
function link(port: number) {
  const made = serverLink(() => port);
  cleanups.push(() => made.close());
  return made;
}

test('the link is not up, after the wait, when nothing listens', async () => {
  const server = link(await freePort());
  const startedAt = performance.now();
  expect(await server.up(200)).toBe(false);
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(190);
});

test('the link waits for a server that starts, then answers at once on the one connection it keeps', async () => {
  const port = await freePort();
  const server = link(port);
  const waiting = [server.up(5000), server.up(5000)];
  await sleep(150);
  const listener = await listen(port);
  expect(await Promise.all(waiting)).toEqual([true, true]);
  // Up without a wait, and without a connection per question.
  for (let i = 0; i < 20; i++) expect(server.up(5000)).toBe(true);
  await sleep(100);
  expect(listener.accepted()).toBe(1);
});

test('the link drops when the server goes away, and waits for the next one', async () => {
  const port = await freePort();
  const server = link(port);
  const first = await listen(port);
  expect(await server.up(5000)).toBe(true);
  await first.stop();
  // The close of the kept connection reaches the link: it waits again, here for nothing.
  let asked: true | Promise<boolean> = true;
  await expect
    .poll(
      () => {
        asked = server.up(50);
        return asked;
      },
      { timeout: 2000 },
    )
    .not.toBe(true);
  expect(await asked).toBe(false);
  const waiting = server.up(5000);
  await sleep(100);
  const second = await listen(port);
  expect(await waiting).toBe(true);
  expect(server.up(5000)).toBe(true);
  expect(second.accepted()).toBe(1);
});
