// The dev loop (`server/dev.ts`) when the entry fails on its first evaluation: `pnpm dev` started while a file is
// broken waits for the fix (as `bun --hot` did), except for a listen error (port taken), which ends it.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { startDev } from './dev';
import { tempDir } from './testing/tempDir';

const g = globalThis as { __devStarted?: string; __llamaWebuiDevHost?: unknown };
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  delete g.__devStarted;
  delete g.__llamaWebuiDevHost;
});

function project(entry: string) {
  const dir = tempDir('lw-dev-start-');
  cleanup.push(() => dir[Symbol.dispose]());
  const src = join(dir.path, 'src');
  mkdirSync(src);
  const write = (name: string, text: string) => {
    writeFileSync(join(src, `${name}.tmp`), text);
    renameSync(join(src, `${name}.tmp`), join(src, name));
  };
  write('entry.ts', entry);
  const start = () =>
    startDev({
      entry: join(src, 'entry.ts'),
      watch: [src],
      config: { configFile: false, root: dir.path, logLevel: 'silent' },
    });
  return { write, start };
}

test('an entry that throws on the first evaluation: startDev waits, and the fix is evaluated', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  cleanup.push(() => errors.mockRestore());
  const p = project("throw new Error('half-edited');\n");
  const dev = await p.start();
  cleanup.push(() => dev.vite.close());
  expect(errors.mock.calls.flat().join(' ')).toContain('half-edited');
  p.write('entry.ts', "(globalThis as { __devStarted?: string }).__devStarted = 'fixed';\n");
  await vi.waitFor(() => expect(g.__devStarted).toBe('fixed'), { timeout: 8000, interval: 20 });
}, 20_000);

test('a listen error on the first evaluation (port taken) still ends startDev', async () => {
  const p = project(
    "throw Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE', syscall: 'listen' });\n",
  );
  await expect(p.start()).rejects.toThrow('EADDRINUSE');
}, 20_000);
