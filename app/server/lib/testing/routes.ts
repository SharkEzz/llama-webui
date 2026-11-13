import { type EventHandler, H3 } from 'nitro/h3';
import { errorResponse } from '../http';

/** Route files' handlers on an h3 app of their own, errors answered as the app does (`server/error.ts`). */
export function routeApp(routes: [method: Parameters<H3['on']>[0], path: string, handler: EventHandler][]): H3 {
  const app = new H3({ onError: (error) => errorResponse(error.cause ?? error) });
  for (const [method, path, handler] of routes) app.on(method, path, handler);
  return app;
}
