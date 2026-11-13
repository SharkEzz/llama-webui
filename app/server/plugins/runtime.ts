import { setTimeout as sleep } from 'node:timers/promises';
import { parentPort } from 'node:worker_threads';
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
  // Development (the Vite process stops the worker), and the second call of production's: waits for the same undo.
  nitroApp.hooks.hook('close', () => stop());
  if (import.meta.dev) onWorkerShutdown(() => stop());
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

const SHUTDOWN_LISTENER = Symbol.for('llama-webui.workerShutdown');

/**
 * Development: runs `undo` as soon as the Vite process asks the dev worker to shut down, before the worker closes its
 * HTTP server. Nitro 3.0.261103-rc sends that `shutdown` message without a `timeout`: the worker then waits for every
 * connection to end before it runs the `close` hooks, and the upstream socket of a proxied `/ws` (an open page) never
 * ends on its own, so Nitro force-closes the worker after 5 s (“Dev worker did not shut down in time”) without the
 * runtime ever undone. Undone first, the hub closes its sockets (1001, then drops the one that never answers) and the
 * server closes within a second. One listener per worker: the plugin runs again on every dev reload. A failure is
 * reported by the `close` hook, whose `stop()` waits for the same undo.
 */
function onWorkerShutdown(undo: () => Promise<void>): void {
  if (!parentPort) return;
  const g = globalThis as { [SHUTDOWN_LISTENER]?: (message: unknown) => void };
  const previous = g[SHUTDOWN_LISTENER];
  if (previous) parentPort.off('message', previous);
  const listener = (message: unknown) => {
    if ((message as { event?: unknown } | null)?.event === 'shutdown') undo().catch(() => {});
  };
  g[SHUTDOWN_LISTENER] = listener;
  parentPort.on('message', listener);
}

declare module 'nitro/types' {
  interface NitroRuntimeHooks {
    /** Nitro's `shutdown` hook (nitrojs/nitro#5099), unreleased in 3.0.261103-rc: emitted by this plugin until then. */
    shutdown: (ctx: { waitUntil: (promise: Promise<unknown>) => void; signal: AbortSignal }) => void | Promise<void>;
  }
}
