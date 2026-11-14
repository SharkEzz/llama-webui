// @effect-diagnostics-next-line nodeBuiltinImport:off NodeHttpServer.layer takes the server factory of node:http itself
import { createServer } from 'node:http';
import { NodeHttpServer } from '@effect/platform-node';
import { Api, RouteNotFound } from '@llama-webui/shared';
import { Array as Arr, Cause, Effect, ErrorReporter, Layer } from 'effect';
import { HttpRouter, HttpServer, HttpServerResponse } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { AppConfig } from '../config/AppConfig.ts';
import { AppInfo } from '../config/AppInfo.ts';
import { HealthHandlers } from '../health/http.ts';
import { SettingsHandlers } from '../settings/http.ts';
import { WsHub } from '../ws/WsHub.ts';
import { guard } from './Guard.ts';
import { RequestErrorsLive } from './RequestErrors.ts';
import * as Static from './Static.ts';
import { noTrailingSlash } from './TrailingSlash.ts';

/** Any other path under /api, whatever the method: a 404 `RouteNotFound` as JSON, not the UI's page. */
const UnknownApi = HttpRouter.add(
  '*',
  '/api/*',
  HttpServerResponse.schemaJson(RouteNotFound)(RouteNotFound.make({ message: 'Unknown route' }), { status: 404 }).pipe(
    Effect.orDie,
  ),
);

/**
 * The endpoints of the API (each group's handlers, and the answer to a request that does not decode), and the 404 of
 * any other /api path.
 */
export const ApiRoutes = Layer.merge(
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(Layer.mergeAll(HealthHandlers, SettingsHandlers).pipe(Layer.provideMerge(RequestErrorsLive))),
  ),
  UnknownApi,
);

/**
 * A defect of a handler, not the response the router carries as one (the 404 of a missing file, the 500 that answers
 * a defect), nor an error Effect marks as not to report (the 400 of a payload that does not decode).
 */
const isDefect = (reason: Cause.Reason<unknown>): boolean =>
  Cause.isDieReason(reason) &&
  !HttpServerResponse.isHttpServerResponse(reason.defect) &&
  !ErrorReporter.isIgnored(reason.defect);

/** A defect is logged: the client only gets a 500 without its message. */
const logDefects = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.tapCause(app, (cause) =>
    Arr.some(cause.reasons, isDefect) ? Effect.logError('a request failed', cause) : Effect.void,
  );

/**
 * `routes` on the HTTP server as the app serves them: behind the guard, a trailing slash under /api and /ws
 * redirected, defects logged, no access log.
 */
export const serve = <A, E, R>(routes: Layer.Layer<A, E, R>) =>
  HttpRouter.serve(routes, {
    disableLogger: true,
    disableListenLog: true,
    middleware: (app) => app.pipe(noTrailingSlash, logDefects, guard),
  });

/**
 * How the Node server runs, on any address: a stop waits half a second for open connections, then cuts them; a client
 * message over 4096 bytes closes its WebSocket with 1009 (`ws` does it).
 */
export const SERVER_OPTIONS = {
  gracefulShutdownTimeout: '500 millis',
  websocket: { maxPayload: 4096 },
} as const;

/** The Node server on the configured address. */
const Server = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port } = yield* AppConfig;
    return NodeHttpServer.layer(createServer, { host, port, ...SERVER_OPTIONS });
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
  Layer.provideMerge(serve(Layer.mergeAll(ApiRoutes, WsHub.route, Static.layer))),
  Layer.provide(Server),
);
