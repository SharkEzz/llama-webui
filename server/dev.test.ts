// The dev loop (`server/dev.ts`) on a small graph: `entry.ts` → `slow.ts` (300 ms at evaluation) → `label.ts`. The
// entry pushes its label on a global: one push per evaluation. Each edit is an atomic replace (write then rename),
// as an editor's safe write or `git checkout` does it.
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { startDev } from './dev';
import { tempDir } from './testing/tempDir';

const dir = tempDir('lw-dev-');
const src = join(dir.path, 'src');
const g = globalThis as { __devLabels?: string[]; __llamaWebuiDevHost?: unknown };
let dev: Awaited<ReturnType<typeof startDev>>;

const write = (name: string, text: string) => {
  const path = join(src, name);
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
};
const label = (l: string) => write('label.ts', `export const label = '${l}';\n`);
const labels = () => g.__devLabels ?? [];
const quiet = () => new Promise((r) => setTimeout(r, 1000));

/** Waits for `want` as the last evaluation, then for the graph to settle; the evaluations since `from`. */
async function evaluationsUntil(want: string, from: number): Promise<string[]> {
  await vi.waitFor(() => expect(labels().at(-1)).toBe(want), { timeout: 8000, interval: 20 });
  await quiet();
  return labels().slice(from);
}

beforeAll(async () => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(src);
  label('a');
  write('slow.ts', "await new Promise((r) => setTimeout(r, 300));\nexport { label } from './label';\n");
  write(
    'entry.ts',
    "import { label } from './slow';\n(globalThis as { __devLabels?: string[] }).__devLabels ??= [];\n" +
      '(globalThis as { __devLabels: string[] }).__devLabels.push(label);\n',
  );
  dev = await startDev({
    entry: join(src, 'entry.ts'),
    watch: [src],
    config: { configFile: false, root: dir.path, logLevel: 'silent' },
  });
}, 30_000);
afterAll(async () => {
  await dev?.vite.close();
  delete g.__devLabels;
  delete g.__llamaWebuiDevHost;
  dir[Symbol.dispose]();
});

test('startDev evaluates the entry and publishes the dev host (its http server and the Vite middlewares)', () => {
  expect(labels()).toEqual(['a']);
  expect(g.__llamaWebuiDevHost).toEqual({ http: dev.http, web: dev.vite.middlewares });
  expect(dev.http.listening).toBe(false);
});

test('a plain edit evaluates the entry once, with the new content', async () => {
  const from = labels().length;
  label('b');
  expect(await evaluationsUntil('b', from)).toEqual(['b']);
}, 15_000);

test('a syntax error, then its fix: one evaluation, with the fixed content', async () => {
  const from = labels().length;
  write('label.ts', "export const label = 'c\n");
  await quiet();
  expect(labels().length).toBe(from);
  label('c');
  expect(await evaluationsUntil('c', from)).toEqual(['c']);
}, 15_000);

test('an import of a missing file, then its creation: evaluated', async () => {
  const from = labels().length;
  write('label.ts', "export { label } from './later';\n");
  await quiet();
  write('later.ts', "export const label = 'd';\n");
  expect(await evaluationsUntil('d', from)).toEqual(['d']);
}, 15_000);

test('two writes 5 ms then 100 ms apart: the last content wins', async () => {
  for (const gap of [5, 100]) {
    const from = labels().length;
    label(`e${gap}`);
    await new Promise((r) => setTimeout(r, gap));
    label(`f${gap}`);
    const seen = await evaluationsUntil(`f${gap}`, from);
    expect(seen.at(-1)).toBe(`f${gap}`);
  }
}, 20_000);

test('an edit after those bursts still reloads', async () => {
  const from = labels().length;
  label('g');
  expect(await evaluationsUntil('g', from)).toEqual(['g']);
}, 15_000);
