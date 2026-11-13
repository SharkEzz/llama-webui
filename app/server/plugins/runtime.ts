import { definePlugin } from 'nitro';
import { start, stop } from '../lib/context.ts';

/**
 * Starts llama-webui with the server (Nitro waits for no plugin: requests wait in `middleware/00.ready.ts`). Called
 * again on every dev reload, with a new `nitroApp`: `start()` keeps the live runtime unless business code changed.
 * Nitro's shutdown (SIGINT, SIGTERM) awaits `close`, which undoes the runtime.
 */
export default definePlugin((nitroApp) => {
  start().catch(() => {
    // Production: a failed startup ends the process, as before Nitro. Development: the error stays on screen and the
    // next save of business code tries again.
    if (!import.meta.dev) process.exit(1);
  });
  nitroApp.hooks.hook('close', () => stop());
});
