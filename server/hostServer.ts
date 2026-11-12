// The HTTP server of the app, from Hono's Node adapter: requests and WebSocket upgrades go to the app that the last
// `mount()` put on it (`server/host.ts`). Long-lived: in development `server/dev.ts` creates it once, before Vite (its
// HMR listens on it), and every reload mounts the new app on it. Run by plain `node` from `server/dev.ts` (erasable
// TS, imports only node:*, `@hono/node-server` and `ws`).
import { IncomingMessage, Server } from 'node:http';
import { createAdaptorServer, type Http2Bindings, type HttpBindings } from '@hono/node-server';
import { WebSocketServer } from 'ws';

/** What the app of a `mount()` answers: the adapter's bindings are Node's request and response. */
export type HostFetch = (req: Request, env: HttpBindings) => Response | Promise<Response>;

/**
 * The app of the last `mount()`, kept on the server under a registry symbol: a development reload evaluates
 * `server/host.ts` again, and its new app must replace the one the old module mounted.
 */
export const HOST_APP = Symbol.for('llama-webui.host.app');
export type HostServer = Server & { [HOST_APP]?: HostFetch };

/**
 * The largest message a client may send: the protocol only has `ping` and `pong` (`ws` allows 100 MiB by default,
 * buffered whole before the hub parses it). A larger one closes the socket (1009).
 */
const MAX_CLIENT_MESSAGE_BYTES = 4096;

/** Node's HTTP/1 bindings: the adapter's types also cover HTTP/2, which a `node:http` server never gets. */
const isHttp1 = (env: HttpBindings | Http2Bindings): env is HttpBindings => env.incoming instanceof IncomingMessage;

export function createHostServer(): HostServer {
  const server = createAdaptorServer({
    fetch: (req, env) => {
      const app = hosted[HOST_APP];
      if (!app) return new Response('llama-webui is starting', { status: 503 });
      if (!isHttp1(env)) return new Response('HTTP/1 expected', { status: 505 });
      return app(req, env);
    },
    // Keep Node's own Request/Response: the app and its tests build them too.
    overrideGlobalObjects: false,
    websocket: { server: new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES }) },
  });
  // Without a `createServer` option the adapter makes a `node:http` server.
  if (!(server instanceof Server)) throw new Error('@hono/node-server: a node:http server was expected');
  const hosted: HostServer = server;
  return hosted;
}
