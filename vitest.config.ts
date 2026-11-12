// Unit tests on Node (Vitest). One project per code base. Until N8 the app still runs on Bun: `pnpm test:bun` replays
// the server, scripts and shared tests under `bun test` too (Bun and Node differ, see server/db/sqlite.ts), including
// the files that boot Bun.serve or Bun.build. llamacpp-js keeps node:test.
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Files that need the Bun runtime (Bun.serve, Bun.build): only `pnpm test:bun` runs them. */
export const BUN_ONLY = ['server/routes/routes.test.ts', 'server/routes/web.test.ts'];

export default defineConfig({
  // Keep `using` native: the default transform downlevels it (N0(f)).
  oxc: { target: 'esnext' },
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          include: ['server/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...BUN_ONLY],
        },
      },
      { extends: true, test: { name: 'shared', include: ['packages/webui-shared/src/**/*.test.ts'] } },
      {
        extends: true,
        resolve: { alias: { '@': dir('./web/src') } },
        test: { name: 'web', include: ['web/src/**/*.test.ts'] },
      },
      {
        extends: true,
        resolve: { alias: { '@': dir('./site/src') } },
        test: { name: 'site', include: ['site/src/**/*.test.ts', 'site/scripts/**/*.test.ts'] },
      },
    ],
  },
});
