// Helpers shared by the tests (`node --test`).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

/** The repository's `testdata/` directory (captured outputs of llama.cpp). */
export const TESTDATA = join(import.meta.dirname, '../../../testdata');

/** A file of `testdata/`, as text. */
export const fixture = (path: string): Promise<string> => readFile(join(TESTDATA, path), 'utf8');

/** `actual` equals `expected` to `digits` decimal places. */
export function closeTo(actual: number, expected: number, digits = 2): void {
  assert.ok(
    Math.abs(actual - expected) < 10 ** -digits / 2,
    `${actual} is not close to ${expected} (${digits} digits)`,
  );
}

/** Every property of `expected` is deeply equal in `actual`, which may have others. */
export function matchObject(actual: unknown, expected: object): void {
  assert.ok(actual !== null && typeof actual === 'object', `${actual} is not an object`);
  for (const [key, value] of Object.entries(expected)) {
    const got: unknown = (actual as Record<string, unknown>)[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) matchObject(got, value);
    else assert.deepEqual(got, value, `property ${key}`);
  }
}

/** Starts an HTTP server on a free loopback port; `close` stops it. */
export async function serve(handler: RequestListener): Promise<{ port: number; close: () => void }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
