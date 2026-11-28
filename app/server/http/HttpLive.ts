// @effect-diagnostics-next-line nodeBuiltinImport:off NodeHttpServer.layer takes the server factory of node:http itself
import { createServer } from 'node:http';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { Api, RouteNotFound } from '@llama-webui/shared';
import {
  Array as Arr,
  Cause,
  Clock,
  Duration,
  Effect,
  ErrorReporter,
  Exit,
  Layer,
  Metric,
  String as Str,
} from 'effect';
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { BenchHandlers, SweepsHandlers } from '../bench/http.ts';
import { ChatHandlers } from '../chat/http.ts';
import { AppConfig } from '../config/AppConfig.ts';
import { AppInfo } from '../config/AppInfo.ts';
import { DownloadsHandlers } from '../downloads/http.ts';
import { FlagsHandlers } from '../flags/http.ts';
import { HealthHandlers } from '../health/http.ts';
import { HfHandlers } from '../hf/http.ts';
import { LogsHandlers } from '../logs/http.ts';
import { ModelsHandlers } from '../models/http.ts';
import { MonitorHandlers } from '../monitor/http.ts';
import { ProfilesHandlers } from '../profiles/http.ts';
import { HttpMetrics, statusClass } from '../runtime/Metrics.ts';
import { SettingsHandlers } from '../settings/http.ts';
import { ServerHandlers } from '../supervisor/http.ts';
import { TuningHandlers } from '../tuning/http.ts';
import { SetupHandlers } from '../tuning/setup.ts';
import { WsHub } from '../ws/WsHub.ts';
import { Guarded } from './Guard.ts';
import { RequestErrorsLive } from './RequestErrors.ts';
import * as Static from './Static.ts';

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
 * any other /api path, all behind the guard and the 308 of a trailing slash.
 */
export const ApiRoutes = Layer.merge(
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(
      Layer.mergeAll(
        HealthHandlers,
        SettingsHandlers,
        ProfilesHandlers,
        FlagsHandlers,
        LogsHandlers,
        ServerHandlers,
        MonitorHandlers,
        ChatHandlers,
        ModelsHandlers,
        HfHandlers,
        DownloadsHandlers,
        BenchHandlers,
        SweepsHandlers,
        TuningHandlers,
        SetupHandlers,
      ).pipe(Layer.provideMerge(RequestErrorsLive)),
    ),
  ),
  UnknownApi,
).pipe(Layer.provide(Guarded));

/**
 * A defect of a handler, not the response the router carries as one (the 404 of a missing file, the 500 that answers
 * a defect), nor an error Effect marks as not to report (the 400 of a payload that does not decode).
 */
const isDefect = (reason: Cause.Reason<unknown>): boolean =>
  Cause.isDieReason(reason) &&
  !HttpServerResponse.isHttpServerResponse(reason.defect) &&
  !ErrorReporter.isIgnored(reason.defect);

/** A defect is logged and counted: the client only gets a 500 without its message. */
const logDefects = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.tapCause(app, (cause) =>
    Arr.some(cause.reasons, isDefect)
      ? Effect.logError('a request failed', cause).pipe(Effect.andThen(Metric.update(HttpMetrics.defects, 1)))
      : Effect.void,
  );

/**
 * Every response counted and timed by its method and the class of its status: the status of a failure is the one the
 * server answers it with, a request whose client went away (interrupted) is `aborted`.
 */
const measure = Effect.fnUntraced(function* <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const started = yield* Clock.currentTimeMillis;
  const exit = yield* Effect.exit(app);
  const ended = yield* Clock.currentTimeMillis;
  const kind = Exit.isSuccess(exit)
    ? statusClass(exit.value.status)
    : Cause.hasInterruptsOnly(exit.cause)
      ? 'aborted'
      : statusClass(HttpServerError.causeResponseStripped(exit.cause)[0].status);
  yield* Metric.update(Metric.withAttributes(HttpMetrics.requests, { method: request.method, class: kind }), 1);
  yield* Metric.update(Metric.withAttributes(HttpMetrics.duration, { class: kind }), Duration.millis(ended - started));
  return yield* exit;
});

/**
 * A JSON response of 1 KiB or more in gzip for a client that accepts it (#105): the lists of the API (flags, models,
 * history) shrink about fourfold. Nothing else: a stream of events (SSE) goes out as written, each event at once,
 * and the UI's assets are compressed at build time (`Static.ts`). No response holds a secret (the Hugging Face token
 * never leaves the server), so the compressed length of a reply that echoes what a client sent tells nothing
 * (BREACH).
 */
const compressJson = HttpMiddleware.compression({
  algorithms: ['gzip'],
  compressible: Str.startsWith('application/json'),
  minSize: 1024,
});

/**
 * `routes` on the HTTP server as the app serves them: JSON compressed (`compressJson`), defects logged, every response
 * measured (`HttpMetrics`), no access log. The guard is not here: it is on the routes it protects (`Guarded`: `ApiRoutes`, `WsHub.route`).
 */
export const serve = <A, E, R>(routes: Layer.Layer<A, E, R>) =>
  HttpRouter.serve(routes, {
    disableLogger: true,
    disableListenLog: true,
    middleware: (app) => app.pipe(compressJson, logDefects, measure),
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
