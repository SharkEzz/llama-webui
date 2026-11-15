import { copyFileSync, cpSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type TempDir, tempDir } from './tempDir.ts';

/** The checkout's `app/`. */
const SOURCE = resolve(import.meta.dirname, '../..');

/** Vite's caches, left out of the copy's `node_modules`: the copy has its own. */
const CACHES = new Set(['.vite', '.vite-temp']);

export interface DevCopy extends TempDir {
  /** The copy of `app/`, where `vite dev` runs. */
  readonly app: string;
}

/**
 * A copy of `app/` for the dev loop's tests, in the repository's `.cache/` (ignored by git, in the workspace): a test
 * edits its files and runs `vite dev` in it, the checkout and a `pnpm dev` the developer runs meanwhile are left alone.
 * Without the build, the dependencies and the developer's own `.env*` (the tests write theirs); `node_modules` linked
 * entry by entry to `app/`'s; `tsconfig.base.json` next to it, as in the repository. Deleted when disposed.
 */
export function devCopy(): DevCopy {
  const work = tempDir('lw-dev-app-', join(SOURCE, '../.cache'));
  const app = join(work.path, 'app');
  cpSync(SOURCE, app, {
    recursive: true,
    filter: (src) => !/^\/(?:node_modules|\.output|\.env[^/]*)(?:\/|$)/.test(src.slice(SOURCE.length)),
  });
  mkdirSync(join(app, 'node_modules'));
  for (const entry of readdirSync(join(SOURCE, 'node_modules')))
    if (!CACHES.has(entry)) symlinkSync(join(SOURCE, 'node_modules', entry), join(app, 'node_modules', entry));
  copyFileSync(join(SOURCE, '../tsconfig.base.json'), join(work.path, 'tsconfig.base.json'));
  return { ...work, app };
}
