import { expect, test } from 'bun:test';
import { tempDir } from '../testing/tempDir';
import { writeFileDeep } from '../testing/write';
import { buildWebRoutes, unavailableWebRoutes } from './web';

test('buildWebRoutes: the real UI, split per page, absolute paths, three.js only in the Topology chunks', async () => {
  const routes = await buildWebRoutes(`${import.meta.dirname}/../../web/index.html`);
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
  const withNode: string[] = [];
  for (const c of chunks) {
    const js = await (routes[c] as Response).clone().text();
    if (js.includes('WebGLRenderer')) withThree.push(c);
    // The browser has no `node:*` module: one in the bundle means server code leaked past the typed client.
    if (/(?:from|import)\s*\(?\s*["']node:/.test(js)) withNode.push(c);
  }
  expect(withThree.length).toBeGreaterThan(0);
  expect(withNode).toEqual([]);
  expect((routes[entry] as Response).headers.get('Cache-Control')).toContain('immutable');
}, 30_000);

test('buildWebRoutes: a broken front rejects; unavailableWebRoutes then answers every page with the error', async () => {
  using dir = tempDir('lw-web-');
  await writeFileDeep(
    `${dir.path}/index.html`,
    '<html><body><script type="module" src="./app.ts"></script></body></html>',
  );
  await writeFileDeep(`${dir.path}/app.ts`, "import './missing';\n");
  const err = await buildWebRoutes(`${dir.path}/index.html`).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AggregateError);
  const page = unavailableWebRoutes(err)['/*'] as Response;
  expect(page.status).toBe(503);
  const text = await page.clone().text();
  expect(text).toContain('web UI unavailable');
  expect(text).toContain('missing');
}, 30_000);
