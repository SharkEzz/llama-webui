// The dev loop (`server/dev.ts`) on a small entry: its `start()` records the dev host it receives on a global. A
// server-side edit restarts the process (`node --watch-path`), so the module runner evaluates the entry only once.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Plugin } from 'vite';
import { afterEach, expect, test } from 'vitest';
import { startDev } from './dev';
import { tempDir } from './testing/tempDir';
import { writeFileAtomic } from './testing/write';

const g = globalThis as { __devStarts?: { label: string; host: unknown }[] };
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  delete g.__devStarts;
});

/** A project whose entry imports `label.ts` and exports `start()` (`body` replaces its default body). */
function project(body = 'g.__devStarts ??= []; g.__devStarts.push({ label, host });') {
  const dir = tempDir('lw-dev-');
  cleanup.push(() => dir[Symbol.dispose]());
  const src = join(dir.path, 'src');
  mkdirSync(src);
  const write = (name: string, text: string) => writeFileAtomic(join(src, name), text);
  write('label.ts', "export const label = 'a';\n");
  write(
    'entry.ts',
    "import { label } from './label';\n" +
      'const g = globalThis as { __devStarts?: { label: string; host: unknown }[] };\n' +
      `export async function start(host: unknown) { ${body} }\n`,
  );
  let closed = false;
  const closing: Plugin = {
    name: 'closing',
    closeBundle() {
      closed = true;
    },
  };
  const start = () =>
    startDev({
      entry: join(src, 'entry.ts'),
      config: { configFile: false, root: dir.path, logLevel: 'silent', plugins: [closing] },
    });
  return { write, start, closed: () => closed };
}

test('startDev evaluates the entry once and calls its start() with the dev host', async () => {
  const p = project();
  const dev = await p.start();
  cleanup.push(() => dev.vite.close());
  expect(g.__devStarts).toEqual([{ label: 'a', host: { http: dev.http, web: dev.vite.middlewares } }]);
  expect(dev.http.listening).toBe(false);
}, 20_000);

test('an edit of a server file does not evaluate the entry again (the process restarts instead)', async () => {
  const p = project();
  const dev = await p.start();
  cleanup.push(() => dev.vite.close());
  p.write('label.ts', "export const label = 'b';\n");
  p.write('entry.ts', "export async function start() { throw new Error('evaluated again'); }\n");
  await sleep(1000);
  expect(g.__devStarts?.map((s) => s.label)).toEqual(['a']);
}, 20_000);

test('an entry whose start() throws rejects startDev, with Vite closed', async () => {
  const p = project("throw new Error('half-edited');");
  await expect(p.start()).rejects.toThrow('half-edited');
  expect(p.closed()).toBe(true);
}, 20_000);
