import { createServer } from 'node:net';
import { expect, test } from 'vitest';
import { freePort } from './launch.ts';

test('freePort gives distinct ports below the ephemeral range and skips one already taken', async () => {
  const first = await freePort();
  const taken = createServer();
  // The port the next call would give, held by someone else.
  await new Promise<void>((listening) => taken.listen(first + 1, '127.0.0.1', listening));
  try {
    const ports = [first];
    for (let i = 0; i < 20; i++) ports.push(await freePort());
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports.every((p) => p >= 10_000 && p < 32_768)).toBe(true);
    expect(ports).not.toContain(first + 1);
  } finally {
    await new Promise((closed) => taken.close(closed));
  }
});
