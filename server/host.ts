import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type HttpBindings, upgradeWebSocket } from '@hono/node-server';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { HOST_APP, type HostServer } from './hostServer';
import { errorResponse } from './http';
import { webHeaders } from './llamaFetch';
import { guard } from './security';
import { hubEvents } from './ws/attach';
import type { WsHub } from './ws/hub';

/** What the host app sees of a request: the Node adapter's bindings (`incoming`, `outgoing`). */
export type HostEnv = { Bindings: HttpBindings };

/** The UI: Vite's middlewares in development, the built files in production (`server/routes/web.ts`). */
export type WebHandler = (c: Context<HostEnv>) => Response | Promise<Response>;

export interface MountOptions {
  /** From `createHostServer()`, not listening yet: in development `server/dev.ts` creates it, before Vite. */
  server: HostServer;
  /** The API (`createApi(deps).fetch`): `/api/*`. */
  fetch: (req: Request, env: object) => Response | Promise<Response>;
  hub: WsHub;
  web: WebHandler;
  hostname: string;
  port: number;
}

/**
 * What the guard reads of a request, from Node's: `req.url` is built from the Host header (a Host that is
 * not an authority makes it unparsable: the guard refuses it, 400).
 */
function head(req: IncomingMessage): Pick<Request, 'url' | 'method' | 'headers'> {
  return {
    url: `http://${req.headers.host ?? ''}${req.url ?? '/'}`,
    method: req.method ?? 'GET',
    headers: webHeaders(req.headers),
  };
}

/** The path of a request, without its query. */
const pathOf = (req: IncomingMessage) => (req.url ?? '/').split('?', 1)[0] ?? '/';

/**
 * The same guard as the API on `/ws`. A WebSocket upgrade it refuses comes here as a plain request
 * (`shouldUpgradeCallback`), and is answered on a connection the server closes: a WebSocket client may keep its own
 * side open.
 */
const wsGuard: MiddlewareHandler<HostEnv> = async (c, next) => {
  const refused = guard(c.req.raw);
  if (!refused) return next();
  if (c.req.header('upgrade') !== undefined) refused.headers.set('Connection', 'close');
  return refused;
};

/**
 * The app: `/api/*` → the API, `/ws` → the WebSocket hub (`upgradeWebSocket` of the Node adapter, 426 without an
 * upgrade), anything else → the UI.
 */
function hostApp(o: MountOptions) {
  const app = new Hono<HostEnv>()
    // The adapter hands every WebSocket upgrade to the app, without a response to write to (`outgoing`). One on
    // another path than `/ws` is answered 404, which the adapter sends only when no other `upgrade` listener is
    // there: in development, Vite's HMR takes its own.
    .use(async (c, next) => {
      if (!c.env.outgoing && c.req.path !== '/ws') return c.body(null, 404);
      await next();
    })
    // `/api/` and below, not `/api` alone (`/api/*` would match it too).
    .all('/api/:rest{.*}', (c) => o.fetch(c.req.raw, c.env))
    .all(
      '/ws',
      wsGuard,
      upgradeWebSocket(() => hubEvents(o.hub)),
      (c) => c.body('WebSocket upgrade expected', 426, { 'Content-Type': 'text/plain;charset=utf-8' }),
    )
    .all('*', o.web);
  app.onError((err) => errorResponse(err));
  return app;
}

/** Mounts the app on `server`, makes it listen and resolves the bound port. */
export function mount(o: MountOptions): Promise<number> {
  const { server } = o;
  server[HOST_APP] = hostApp(o).fetch;
  // Node hands every request with an `Upgrade` header to the `upgrade` listeners, `h2c` included (`curl --http2`):
  // only a WebSocket upgrade goes there, any other is a plain request. Vite's HMR upgrades are WebSocket. One that the
  // guard refuses on `/ws` stays a plain request too: `wsGuard` answers it with its body, as it answers any refused
  // request (the adapter would refuse an upgrade without one).
  (server as { shouldUpgradeCallback?: (req: IncomingMessage) => boolean }).shouldUpgradeCallback = (req) =>
    req.headers.upgrade?.toLowerCase() === 'websocket' && (pathOf(req) !== '/ws' || !guard(head(req)));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.hostname, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
