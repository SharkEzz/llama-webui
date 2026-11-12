import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { getRequestListener } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { webHeaders } from './llamaFetch';
import { guard } from './security';
import { attachSocket } from './ws/attach';
import type { WsHub } from './ws/hub';

/** The UI: Vite's middlewares in development, the built files in production (`server/routes/web.ts`). */
export type WebHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface MountOptions {
  /** Long-lived: in development it survives reloads (the dev host), each evaluation mounts on it again. */
  server: Server;
  /** The API (`createApi(deps).fetch`): `/api/*`. */
  fetch: (req: Request) => Response | Promise<Response>;
  hub: WsHub;
  web: WebHandler;
  hostname: string;
  port: number;
  /** Development: an upgrade on another path than `/ws` belongs to Vite's HMR listener. */
  dev: boolean;
}

type Listeners = {
  request: (req: IncomingMessage, res: ServerResponse) => void;
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
};

/**
 * The listeners a server got from its last `mount()`, kept on the server itself under a registry symbol: a
 * development reload evaluates this module again, and the new instance must find what the old one mounted.
 */
const MOUNTED = Symbol.for('llama-webui.host.mounted');
type Mounted = Server & {
  [MOUNTED]?: Listeners;
  /** Set by the `shouldUpgradeCallback` option of `createServer()`, or later (Node's types only know the option). */
  shouldUpgradeCallback?: (req: IncomingMessage) => boolean;
};

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
export const pathOf = (req: IncomingMessage) => (req.url ?? '/').split('?', 1)[0] ?? '/';

/**
 * The largest message a client may send: the protocol only has `ping` and `pong` (`ws` allows 100 MiB by default,
 * buffered whole before the hub parses it). A larger one closes the socket (1009).
 */
const MAX_CLIENT_MESSAGE_BYTES = 4096;

/**
 * `/ws` as a plain request, which a WebSocket upgrade the guard refuses is too (`shouldUpgradeCallback`): the same
 * guard as the API, then 426. A refused upgrade is answered on a connection the server closes: a WebSocket client
 * may keep its own side open.
 */
function wsExpected(req: Request): Response {
  const refused = guard(req);
  if (refused) {
    if (req.headers.has('upgrade')) refused.headers.set('Connection', 'close');
    return refused;
  }
  return new Response('WebSocket upgrade expected', {
    status: 426,
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  });
}

// No `errorHandler`: a request the adapter cannot build (a Host that is not an authority, `a b`) keeps the adapter's
// own answer, 400 without a body.
const listenerOptions = {
  // Keep Node's own Request/Response: the app and its tests build them too.
  overrideGlobalObjects: false,
};

/**
 * Mounts one evaluation of the app on `server`: `/api/*` → the API, `/ws` → the WebSocket hub, anything else → the
 * UI. Replaces the listeners a previous `mount()` put on the same server (a development reload), listens on the
 * first call only, and resolves the bound port.
 */
export function mount(o: MountOptions): Promise<number> {
  const api = getRequestListener(o.fetch, listenerOptions);
  const ws = getRequestListener(wsExpected, listenerOptions);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });

  const request: Listeners['request'] = (req, res) => {
    const path = pathOf(req);
    if (path.startsWith('/api/')) void api(req, res);
    else if (path === '/ws') void ws(req, res);
    else o.web(req, res);
  };
  const upgrade: Listeners['upgrade'] = (req, socket, head_) => {
    if (pathOf(req) !== '/ws') {
      if (!o.dev) socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head_, (client) => attachSocket(o.hub, client));
  };

  const server: Mounted = o.server;
  const previous = server[MOUNTED];
  if (previous) {
    server.off('request', previous.request);
    server.off('upgrade', previous.upgrade);
  }
  server.on('request', request);
  server.on('upgrade', upgrade);
  server[MOUNTED] = { request, upgrade };
  // Node hands every request with an `Upgrade` header to the `upgrade` listeners, `h2c` included (`curl --http2`):
  // only a WebSocket upgrade goes there, any other is a plain request. Vite's HMR upgrades are WebSocket. One that the
  // guard refuses on `/ws` stays a plain request too: `wsExpected` answers it, as it answers any refused request.
  server.shouldUpgradeCallback = (req) =>
    req.headers.upgrade?.toLowerCase() === 'websocket' && (pathOf(req) !== '/ws' || !guard(head(req)));

  const bound = () => (o.server.address() as AddressInfo).port;
  if (o.server.listening) return Promise.resolve(bound());
  return new Promise((resolve, reject) => {
    o.server.once('error', reject);
    o.server.listen(o.port, o.hostname, () => {
      o.server.off('error', reject);
      resolve(bound());
    });
  });
}
