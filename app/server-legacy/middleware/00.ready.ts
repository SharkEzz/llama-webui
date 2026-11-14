import { defineHandler } from 'nitro';
import { ready } from '../lib/context.ts';

/** The API and `/ws` wait for startup; the UI does not. 503 while it cannot answer (failed startup, shutdown). */
export default defineHandler(async (event) => {
  const path = event.url.pathname;
  if (path !== '/api' && !path.startsWith('/api/') && path !== '/ws') return;
  try {
    await ready();
  } catch {
    return new Response('llama-webui is starting', { status: 503 });
  }
});
