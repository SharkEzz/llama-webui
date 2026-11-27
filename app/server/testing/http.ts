import { createServer } from 'node:http';
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { Layer } from 'effect';
import { HttpServer } from 'effect/http';
import { AppConfig } from '../config/AppConfig.ts';
import { SERVER_OPTIONS } from '../http/HttpLive.ts';

/**
 * The app's configuration as the test server listens: on 127.0.0.1 (the variables of the shell running the tests,
 * `LLAMA_WEBUI_HOST` among them, are not read). The port is the free one the server is given; no data folder.
 */
const AppConfigTest = Layer.succeed(
  AppConfig,
  AppConfig.of({ host: '127.0.0.1', port: 0, dataDir: '', dev: false, devToolsUrl: '' }),
);

/**
 * A real Node server on 127.0.0.1 and a free port, run as the app's (`SERVER_OPTIONS`), with the client of
 * the context bound to it, and the app's configuration that says so. A test that stops the server while a response
 * is read provides a client built outside the server's scope, as a browser is.
 */
export const ServerWithClient = HttpServer.layerTestClient.pipe(
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: 0, ...SERVER_OPTIONS })),
  Layer.merge(AppConfigTest),
);

/**
 * `ServerWithClient` with its own client. `NodeHttpServer.layerTest` does the same over `fetch`, which drops a `Host`
 * header: this client goes through `node:http`, which sends it, so the guard can be tried from outside.
 */
export const ServerTest = ServerWithClient.pipe(Layer.provide(NodeHttpClient.layerNodeHttp));
