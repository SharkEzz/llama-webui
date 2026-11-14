// @effect-diagnostics-next-line nodeBuiltinImport:off NodeHttpServer.layer takes the server factory of node:http itself
import { createServer } from 'node:http';
import { NodeHttpServer } from '@effect/platform-node';
import { Api, RouteNotFound } from '@llama-webui/shared';
import { Array as Arr, Cause, Effect, Layer } from 'effect';
import { HttpRouter, HttpServer, HttpServerResponse } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { AppConfig } from '../config/AppConfig.ts';
import { AppInfo } from '../config/AppInfo.ts';
import { HealthHandlers } from '../health/http.ts';
import { guard } from './Guard.ts';
import * as Static from './Static.ts';

/** Any other path under /api, whatever the method: a 404 `RouteNotFound` as JSON, not the UI's page. */
const UnknownApi = HttpRouter.add(
  '*',
  '/api/*',
  HttpServerResponse.schemaJson(RouteNotFound)(RouteNotFound.make({ message: 'Unknown route' }), { status: 404 }).pipe(
    Effect.orDie,
  ),
);

/** The endpoints of the API, and the 404 of any other /api path. */
export const ApiRoutes = Layer.merge(HttpApiBuilder.layer(Api).pipe(Layer.provide(HealthHandlers)), UnknownApi);

/**
 * A defect of a handler, not the response the router carries as one (the 404 of a missing file, the 500 that answers
 * a defect).
 */
const isDefect = (reason: Cause.Reason<unknown>): boolean =>
  Cause.isDieReason(reason) && !HttpServerResponse.isHttpServerResponse(reason.defect);

/** A defect is logged: the client only gets a 500 without its message. */
const logDefects = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.tapCause(app, (cause) =>
    Arr.some(cause.reasons, isDefect) ? Effect.logError('a request failed', cause) : Effect.void,
  );

/** `routes` on the HTTP server as the app serves them: behind the guard, defects logged, no access log. */
export const serve = <A, E, R>(routes: Layer.Layer<A, E, R>) =>
  HttpRouter.serve(routes, {
    disableLogger: true,
    disableListenLog: true,
    middleware: (app) => app.pipe(logDefects, guard),
  });

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
  Layer.provideMerge(serve(Layer.merge(ApiRoutes, Static.layer))),
  Layer.provide(Server),
);
