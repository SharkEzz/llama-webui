import { NodeSocket } from '@effect/platform-node';
import { Effect, Layer, Schema, String as Str } from 'effect';
import { DevTools } from 'effect/devtools';
import { AppConfig } from './config/AppConfig.ts';
import { AppInfo } from './config/AppInfo.ts';
import * as Db from './db/Db.ts';
import { Flags } from './flags/Flags.ts';
import { HttpLive } from './http/HttpLive.ts';
import { LlamaHttp } from './llama/LlamaHttp.ts';
import { LogRing } from './logs/LogRing.ts';
import { ProfilesRepo } from './profiles/ProfilesRepo.ts';
import { Shutdown } from './runtime/Shutdown.ts';
import { SettingsRepo } from './settings/SettingsRepo.ts';
import { WsHub } from './ws/WsHub.ts';

/**
 * The services the routes use, built before the HTTP server opens its port and undone after it closed: the database
 * is opened (and brought up to date) first. Later tasks add theirs, each on `Shutdown.layer`.
 */
const Services = Flags.layer.pipe(
  Layer.provideMerge(Layer.merge(LogRing.layer, LlamaHttp.layer)),
  Layer.provideMerge(Layer.mergeAll(WsHub.layer, SettingsRepo.layer, ProfilesRepo.layer)),
  Layer.provideMerge(AppInfo.layer),
  Layer.provideMerge(Db.layer),
);

/** The HTTP server on the services it uses. */
const Http = HttpLive.pipe(Layer.provide(Services));

/** How long the dev start waits to learn whether the DevTools listen: a refused connection on loopback answers at once. */
const PROBE_TIMEOUT = '200 millis';

/** Whether something accepts a TCP connection at the host and port of the WebSocket URL `url`. */
const accepts = (url: string) =>
  Schema.decodeEffect(Schema.URLFromString)(url).pipe(
    Effect.flatMap(({ hostname, port, protocol }) =>
      NodeSocket.makeNet({
        // `[::1]` is how a URL writes an IPv6 host: a connection takes it without the brackets.
        host: Str.replace(/^\[(.*)\]$/, '$1')(hostname),
        port: port === '' ? (protocol === 'wss:' ? 443 : 80) : Number(port),
        openTimeout: PROBE_TIMEOUT,
      }),
    ),
    Effect.flatMap((socket) => socket.reader),
    Effect.scoped,
    Effect.timeout(PROBE_TIMEOUT),
    Effect.isSuccess,
  );

/**
 * In dev (`LLAMA_WEBUI_DEV=1`, set by `vite dev`), the spans go to the Effect DevTools when they run: the DevTools
 * client waits a second for a first connection, which nothing listening would add to each restart. A production
 * start never adds them, nor looks for them.
 */
const DevToolsInDev = Layer.unwrap(
  Effect.gen(function* () {
    const { dev, devToolsUrl } = yield* AppConfig;
    if (!dev) return Layer.empty;
    if (yield* accepts(devToolsUrl)) {
      yield* Effect.logInfo(`Effect DevTools connected (${devToolsUrl})`);
      return DevTools.layer(devToolsUrl);
    }
    yield* Effect.logInfo(`no Effect DevTools at ${devToolsUrl}: start them, then save a server file`);
    return Layer.empty;
  }),
);

/**
 * The whole application but its configuration. `Shutdown.layerRunner` is built last, so its finalizer is the first
 * to run when the app stops: the shutdown steps run while the HTTP server still serves and clients are connected.
 */
export const App = Shutdown.layerRunner.pipe(
  Layer.provide(Http),
  Layer.provide(Shutdown.layer),
  Layer.provide(DevToolsInDev),
);
