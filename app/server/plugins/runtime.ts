import { setTimeout as sleep } from 'node:timers/promises';
import { definePlugin } from 'nitro';
import { start, stop } from '../lib/context.ts';

/**
 * Starts llama-webui with the server (Nitro waits for no plugin: requests wait in `middleware/00.ready.ts`). Called
 * again on every dev reload, with a new `nitroApp`: `start()` keeps the live runtime unless business code changed.
 */
export default definePlugin((nitroApp) => {
  start().catch(() => {
    // Production: a failed startup ends the process, as before Nitro. Development: the error stays on screen and the
    // next save of business code tries again.
    if (!import.meta.dev) process.exit(1);
  });
  // h3 logs every error it did not create, 4xx included (`HttpError`, `ZodError`): `errorResponse` logs the 500s.
  if (nitroApp.h3) nitroApp.h3.config.silent = true;
  // Production: undone as the server starts closing, while connections drain: sockets close 1001, replies end
  // “stopped”, so the server closes without waiting for its grace delay (5 s).
  nitroApp.hooks.hook('shutdown', ({ waitUntil }) => waitUntil(stop()));
  // Development (the Vite process stops the worker), and the second call of production's: a no-op.
  nitroApp.hooks.hook('close', () => stop());
  if (!import.meta.dev) {
    // Until Nitro calls `shutdown` (it calls `close` only once every connection has ended): emitted on the signal that
    // srvx closes the server for, as Nitro will, its work awaited up to the same 5 s. Registered before srvx's handler
    // (plugins run before `serve()`), which stays for a second signal. srvx installs none when `CI` or `TEST` is set:
    // users never run the server so, and the tests start it without them (`lib/testing/launch.ts`).
    const emitShutdown = async () => {
      const pending: Promise<unknown>[] = [];
      const controller = new AbortController();
      await nitroApp.hooks.callHook('shutdown', { waitUntil: (p) => pending.push(p), signal: controller.signal });
      await Promise.race([Promise.allSettled(pending), sleep(5000, null, { ref: false })]);
      controller.abort();
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void emitShutdown());
  }
});

declare module 'nitro/types' {
  interface NitroRuntimeHooks {
    /** Nitro's `shutdown` hook (nitrojs/nitro#5099), unreleased in 3.0.261103-rc: emitted by this plugin until then. */
    shutdown: (ctx: { waitUntil: (promise: Promise<unknown>) => void; signal: AbortSignal }) => void | Promise<void>;
  }
}
