// @effect-diagnostics-next-line nodeBuiltinImport:off NodeHttpServer.layer takes the server factory of node:http itself
import { createServer } from 'node:http';
import { NodeHttpServer } from '@effect/platform-node';
import { Api } from '@llama-webui/shared';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { AppConfig } from '../config/AppConfig.ts';
import { AppInfo } from '../config/AppInfo.ts';
import { HealthHandlers } from '../health/http.ts';
import * as Static from './Static.ts';

/** Every route: the API, then the UI for any other GET. */
const Routes = Layer.mergeAll(HttpApiBuilder.layer(Api).pipe(Layer.provide(HealthHandlers)), Static.layer);

/** The Node server on the configured address. A stop waits half a second for open connections, then cuts them. */
const Server = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port } = yield* AppConfig;
    return NodeHttpServer.layer(createServer, { host, port, gracefulShutdownTimeout: '500 millis' });
  }),
);

/** Once the server listens and serves, the one line that says so. */
const Ready = Layer.effectDiscard(
  Effect.gen(function* () {
    const { version } = yield* AppInfo;
    yield* HttpServer.addressFormattedWith((url) => Effect.log(`ready (${version}) on ${url}`));
  }),
);

/**
 * The HTTP server: the routes on the Node server, one log line once it serves. The services the routes use are
 * provided from outside (`App.ts`), so they are built before the port is opened.
 */
export const HttpLive = Ready.pipe(
  Layer.provideMerge(HttpRouter.serve(Routes, { disableLogger: true, disableListenLog: true })),
  Layer.provide(Server),
);
