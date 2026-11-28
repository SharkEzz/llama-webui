// A proxy on loopback that refuses every tunnel, for the tests of the clients that go through the proxy of the
// environment (`HfHttp`). Plain Node: it drives the platform from outside.
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Effect, type Scope } from 'effect';

/** A proxy stub: its URL, and the authorities of the tunnels it was asked for so far. */
export interface ConnectStub {
  readonly url: string;
  readonly port: number;
  /** The authority of each `CONNECT` received (`hub.invalid:443`), in order. */
  readonly connects: () => ReadonlyArray<string>;
  /** How many plain (non-`CONNECT`) requests it received. */
  readonly requests: () => number;
}

/**
 * An HTTP proxy on 127.0.0.1 and a port the system gives (outside the ports of the app), for the life of the scope: it
 * records the authority of each `CONNECT`, answers `403 Forbidden` and closes the socket, so no tunnel ever opens. A
 * plain request is answered 502. Every socket is destroyed when the scope closes.
 */
export const connectStub: Effect.Effect<ConnectStub, never, Scope.Scope> = Effect.acquireRelease(
  Effect.promise(async () => {
    const connects: Array<string> = [];
    let requests = 0;
    const sockets = new Set<Socket>();
    const server: Server = createServer((_req, res) => {
      requests++;
      res.writeHead(502).end();
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('connect', (req, socket) => {
      connects.push(req.url ?? '');
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    const stub: ConnectStub = {
      url: `http://127.0.0.1:${port}`,
      port,
      connects: () => connects,
      requests: () => requests,
    };
    return { server, sockets, stub };
  }),
  ({ server, sockets }) =>
    Effect.promise(() => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      return new Promise<void>((done) => server.close(() => done()));
    }),
).pipe(Effect.map(({ stub }) => stub));
