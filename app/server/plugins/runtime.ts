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
  // The SPA's page is revalidated on every load: a new build's `index.html` names new hashed assets (Nitro sets only
  // the assets' own `immutable` cache).
  nitroApp.hooks.hook('response', (res) => {
    if (res.headers.get('content-type')?.startsWith('text/html') && !res.headers.has('cache-control'))
      res.headers.set('cache-control', 'no-cache');
  });
  // Shutdown in development (the Vite process stops the worker), and the second call of production's: a no-op.
  nitroApp.hooks.hook('close', () => stop());
  if (!import.meta.dev) {
    // Production: srvx closes the HTTP server on SIGINT/SIGTERM and Nitro runs `close` only once every connection has
    // ended. An open UI (WebSocket) or a streaming reply would hold it for the whole grace delay (5 s), then be cut
    // off. The runtime is undone first, as before Nitro: sockets close 1001, replies end “stopped”, then the server
    // closes at once. Registered before srvx's handler (plugins run before `serve()`), which stays for a second signal.
    // srvx installs none when `CI` or `TEST` is set: users never run the server so, and the tests start it without them
    // (`lib/testing/launch.ts`).
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void stop());
  }
});
