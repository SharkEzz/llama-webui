// `server/api.gen.ts` (`build/apiTypes.ts`): the route map comes from Nitro's own scan, at start and on every save.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNitro } from 'nitro/builder';
import { nitro } from 'nitro/vite';
import { createServer } from 'vite';
import { afterAll, expect, test } from 'vitest';
import { apiRoutes, apiTypes, render } from '../build/apiTypes.ts';
import { tempDir } from './lib/testing/tempDir';

const APP = resolve(import.meta.dirname, '..');
const dir = tempDir('lw-apigen-');
afterAll(() => dir[Symbol.dispose]());

test('the generated map is Nitro’s own route table', async () => {
  const n = await createNitro({ rootDir: APP, serverDir: './server', ignore: ['lib/**'], preset: 'node_server' });
  try {
    if (!n.options.serverDir) throw new Error('no serverDir');
    const routes = apiRoutes(n.scannedHandlers, n.options.serverDir);
    expect(routes.length).toBe(70);
    expect(routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/api/profiles/:id' }));
    expect(routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/downloads/clear' }));
    expect(readFileSync(join(APP, 'server/api.gen.ts'), 'utf8')).toBe(render(routes));
  } finally {
    await n.close();
  }
}, 30_000);

test('apiRoutes keeps the API routes with a method, reads Body and Query, sorts by path then method', () => {
  const server = join(dir.path, 'unit/');
  const file = (name: string, text: string) => {
    mkdirSync(join(server, 'routes/api'), { recursive: true });
    writeFileSync(join(server, 'routes/api', name), text);
    return join(server, 'routes/api', name);
  };
  const a = file('a.post.ts', 'export type Body = { x: 1 };\nexport default 0;\n');
  const b = file('a.get.ts', 'export type Query = { q?: string };\nexport default 0;\n');
  const routes = apiRoutes(
    [
      { route: '/**', middleware: true, handler: join(server, 'middleware/guard.ts') },
      { route: '/ws', handler: join(server, 'routes/ws.ts') },
      { route: '/api/**', handler: join(server, 'routes/api/[...].ts') },
      { route: '/api/a', method: 'POST', handler: a },
      { route: '/api/a', method: 'GET', handler: b },
    ],
    server,
  );
  expect(routes).toEqual([
    { method: 'GET', path: '/api/a', file: './routes/api/a.get.ts', body: false, query: true },
    { method: 'POST', path: '/api/a', file: './routes/api/a.post.ts', body: true, query: false },
  ]);
});

/** Polls `file` until `check` holds on its text, up to 5 s. */
async function until(file: string, check: (text: string) => boolean): Promise<void> {
  for (let i = 0; i < 250; i++) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {}
    if (check(text)) return;
    await sleep(20);
  }
  throw new Error(`${file}: not as expected within 5 s`);
}

test('in dev, a route file added or deleted updates api.gen.ts', async () => {
  // A project of its own (not app/: other suites read its route map meanwhile).
  const root = join(dir.path, 'project');
  const server = join(root, 'server');
  mkdirSync(join(server, 'routes/api'), { recursive: true });
  writeFileSync(join(server, 'routes/api/a.get.ts'), 'export default () => ({ ok: true });\n');
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>\n');
  const types = apiTypes();
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false },
    plugins: [types.plugin, nitro()],
    nitro: { serverDir: './server', preset: 'node_server', hooks: types.hooks },
  });
  const out = join(server, 'api.gen.ts');
  try {
    await until(out, (t) => t.includes("'GET /api/a'"));
    // A saved route that gains a query type: no rescan, regenerated at once. Saved again until seen: the watcher
    // takes Nitro's directories some time after the server starts.
    const withQuery = 'export type Query = { q?: string };\nexport default 0;\n';
    for (let i = 0; i < 100 && !readFileSync(out, 'utf8').includes('r0.Query'); i++) {
      writeFileSync(join(server, 'routes/api/a.get.ts'), withQuery);
      await sleep(100);
    }
    expect(readFileSync(out, 'utf8')).toContain('Route<typeof r0.default, never, r0.Query>');
    writeFileSync(join(server, 'routes/api/zz-probe.get.ts'), 'export default () => ({ ok: true });\n');
    await until(out, (t) => t.includes("'GET /api/zz-probe'"));
    rmSync(join(server, 'routes/api/zz-probe.get.ts'));
    await until(out, (t) => !t.includes('zz-probe') && t.includes("'GET /api/a'"));
  } finally {
    await vite.close();
  }
}, 60_000);
