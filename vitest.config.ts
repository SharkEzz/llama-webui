// Unit tests on Node (Vitest). One project per code base; the files that still boot Bun.serve or Bun.build run with
// `bun test` (`pnpm test:bun`) until N6/N8. llamacpp-js keeps node:test (`pnpm --filter llamacpp-js test`).
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Files that need the Bun runtime (Bun.serve, Bun.build): run by `pnpm test:bun`; keep the two lists equal. */
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
