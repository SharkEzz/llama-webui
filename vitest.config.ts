// Tests on Node (Vitest), one project per code base; the app's own runtime. llamacpp-js keeps node:test
// (`pnpm --filter llamacpp-js test`).
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import type { Reporter } from 'vitest/node';

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      VITEST_ENABLE_CONSOLE_LOG?: string | undefined;
    }
  }
}

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Fails the run on an async leak: Vitest prints the leaks `detectAsyncLeaks` finds and still exits 0. It reads them
 * where Vitest keeps them for its own summary (`state.leakSet`, no other access): to check on a Vitest upgrade.
 */
function failOnAsyncLeaks(): Reporter {
  return {
    onInit(ctx) {
      ctx.onClose(() => {
        if (ctx.state.leakSet.size > 0) {
          process.exitCode = 1;
        }
      });
    },
  };
}

export default defineConfig({
  // Keep `using` native: the default transform downlevels it.
  oxc: { target: 'esnext' },
  test: {
    environment: 'node',
    // A promise, a timer or a handle a test file leaves behind is reported, and fails the run.
    detectAsyncLeaks: true,
    reporters: [...configDefaults.reporters, failOnAsyncLeaks()],
    logHeapUsage: true,
    // Hide what is written on the console to allow better reading by default.
    onConsoleLog: () => {
      if (process.env.VITEST_ENABLE_CONSOLE_LOG) {
        return true;
      }
      return false;
    },
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
