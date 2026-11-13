import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { OUT, render, scan } from '../scripts/gen-api.ts';

test('server/api.gen.ts is up to date with the file routes', () => {
  expect(readFileSync(OUT, 'utf8')).toBe(render(scan()));
});

test('every route file is in the manifest, under its method and path', () => {
  const routes = scan();
  expect(routes.length).toBe(70);
  expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/api/profiles/:id' }));
  expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/downloads/clear' }));
});
