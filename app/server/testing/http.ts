import { createServer } from 'node:http';
import { NodeHttpClient, NodeHttpServer } from '@effect/platform-node';
import { Layer } from 'effect';
import { HttpServer } from 'effect/http';
import { SERVER_OPTIONS } from '../http/HttpLive.ts';

/**
 * A real Node server on 127.0.0.1 and a free port, run as the app's (`SERVER_OPTIONS`), with the client of
 * the context bound to it. A test that stops the server while a response is read provides a client built outside the
 * server's scope, as a browser is.
 */
export const ServerWithClient = HttpServer.layerTestClient.pipe(
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: 0, ...SERVER_OPTIONS })),
);

/**
 * `ServerWithClient` with its own client. `NodeHttpServer.layerTest` does the same over `fetch`, which drops a `Host`
 * header: this client goes through `node:http`, which sends it, so the guard can be tried from outside.
 */
export const ServerTest = ServerWithClient.pipe(Layer.provide(NodeHttpClient.layerNodeHttp));
