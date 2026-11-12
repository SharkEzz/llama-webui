import { type IncomingMessage, type Server, type ServerResponse, STATUS_CODES } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { getRequestListener, RequestError } from '@hono/node-server';
import { WebSocketServer } from 'ws';
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

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json;charset=utf-8' } });

/**
 * What the guard reads of a request, from Node's: `req.url` is built from the Host header, as Bun did (a Host that is
 * not an authority makes it unparsable: the guard answers `Invalid host`).
 */
function head(req: IncomingMessage): Pick<Request, 'url' | 'method' | 'headers'> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    for (const value of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, value);
  }
  return { url: `http://${req.headers.host ?? ''}${req.url ?? '/'}`, method: req.method ?? 'GET', headers };
}

const pathOf = (req: IncomingMessage) => (req.url ?? '/').split('?', 1)[0] ?? '/';

/** A `Response` written as is to a socket that asked for an upgrade, which is then closed. */
async function writeRaw(socket: Duplex, res: Response): Promise<void> {
  const body = Buffer.from(await res.arrayBuffer());
  const lines = [`HTTP/1.1 ${res.status} ${STATUS_CODES[res.status] ?? ''}`];
  for (const [k, v] of res.headers) lines.push(`${k}: ${v}`);
  lines.push(`content-length: ${body.length}`, 'connection: close', '', '');
  socket.end(Buffer.concat([Buffer.from(lines.join('\r\n')), body]));
}

/** `/ws` without an upgrade: the same guard as the API, then 426. */
function wsExpected(req: Request): Response {
  return (
    guard(req) ??
    new Response('WebSocket upgrade expected', {
      status: 426,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    })
  );
}

const listenerOptions = {
  // Keep Node's own Request/Response: the app and its tests build them too.
  overrideGlobalObjects: false,
  // The adapter cannot build the request URL from a Host that is not an authority (`a b`): the guard's answer.
  errorHandler: (err: unknown) =>
    err instanceof RequestError ? json(403, { error: 'Invalid host' }) : new Response(null, { status: 500 }),
};

/**
 * Mounts one evaluation of the app on `server`: `/api/*` → the API, `/ws` → the WebSocket hub, anything else → the
 * UI. Replaces the listeners a previous `mount()` put on the same server (a development reload), listens on the
 * first call only, and resolves the bound port.
 */
export function mount(o: MountOptions): Promise<number> {
  const api = getRequestListener(o.fetch, listenerOptions);
  const ws = getRequestListener(wsExpected, listenerOptions);
  const wss = new WebSocketServer({ noServer: true });

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
    const refused = guard(head(req));
    if (refused) {
      void writeRaw(socket, refused);
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
  // only a WebSocket upgrade goes there, any other is a plain request (as on Bun). Vite's HMR upgrades are WebSocket.
  server.shouldUpgradeCallback = (req) => req.headers.upgrade?.toLowerCase() === 'websocket';

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
