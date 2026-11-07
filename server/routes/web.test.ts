import { expect, test } from 'bun:test';
import { buildWebRoutes } from './web';

test('buildWebRoutes: the real UI, split per page, absolute paths, three.js only in the Topology chunks', async () => {
  const routes = await buildWebRoutes(`${import.meta.dir}/../../web/index.html`);
  const html = routes['/*'];
  expect(html).toBeInstanceOf(Response);
  const page = await (html as Response).clone().text();
  expect((html as Response).headers.get('Cache-Control')).toBe('no-cache');

  // Everything the page references is served, from the root (a deep URL like /chat/12 must find it too).
  const refs = [...page.matchAll(/(?:src|href)="([^"]+\.(?:js|css|svg))"/g)].map((m) => m[1]!);
  expect(refs.length).toBeGreaterThanOrEqual(2);
  for (const r of refs) {
    expect(r.startsWith('/')).toBe(true);
    expect(routes[r]).toBeInstanceOf(Response);
  }

  const entry = refs.find((r) => r.endsWith('.js'))!;
  const entryJs = await (routes[entry] as Response).clone().text();
  const chunks = Object.keys(routes).filter((k) => k.endsWith('.js'));
  expect(chunks.length).toBeGreaterThan(10); // one or more per page
  expect(entryJs).not.toContain('WebGLRenderer');
  const withThree: string[] = [];
  for (const c of chunks) {
    if ((await (routes[c] as Response).clone().text()).includes('WebGLRenderer')) withThree.push(c);
  }
  expect(withThree.length).toBeGreaterThan(0);
  expect((routes[entry] as Response).headers.get('Cache-Control')).toContain('immutable');
}, 30_000);
