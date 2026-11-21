// Tests on Node (Vitest), one project per code base; the app's own runtime. llamacpp-js keeps node:test
// (`pnpm --filter llamacpp-js test`).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Keep `using` native: the default transform downlevels it.
  oxc: { target: 'esnext' },
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          include: ['app/server/**/*.test.ts', 'app/build/**/*.test.ts', 'scripts/**/*.test.ts'],
          // One production build per run, for the suites that start it (contract, lifecycle, build output).
          globalSetup: ['app/server/testing/build.ts'],
        },
      },
      { extends: true, test: { name: 'shared', include: ['packages/webui-shared/src/**/*.test.ts'] } },
      {
        extends: true,
        resolve: { alias: { '@': dir('./app/src') } },
        test: { name: 'web', include: ['app/src/**/*.test.ts'] },
      },
      {
        extends: true,
        resolve: { alias: { '@': dir('./site/src') } },
        test: { name: 'site', include: ['site/src/**/*.test.ts', 'site/scripts/**/*.test.ts'] },
      },
    ],
  },
});
