// Tests on Node (Vitest), one project per code base; the app's own runtime. llamacpp-js keeps node:test
// (`pnpm --filter llamacpp-js test`).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

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
