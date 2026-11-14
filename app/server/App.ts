import { Layer } from 'effect';
import { DevTools } from 'effect/devtools';
import { AppConfig } from './config/AppConfig.ts';
import { AppInfo } from './config/AppInfo.ts';
import * as Db from './db/Db.ts';
import { HttpLive } from './http/HttpLive.ts';
import { Shutdown } from './runtime/Shutdown.ts';
import { SettingsRepo } from './settings/SettingsRepo.ts';
import { WsHub } from './ws/WsHub.ts';

/**
 * The services the routes use, built before the HTTP server opens its port and undone after it closed: the database
 * is opened (and brought up to date) first. Later tasks add theirs, each on `Shutdown.layer`.
 */
const Services = Layer.mergeAll(WsHub.layer, SettingsRepo.layer).pipe(
  Layer.provideMerge(AppInfo.layer),
  Layer.provideMerge(Db.layer),
);

/** The HTTP server on the services it uses. */
const Http = HttpLive.pipe(Layer.provide(Services));

/**
 * In dev (`LLAMA_WEBUI_DEV=1`, set by `vite dev`), the spans go to the Effect DevTools; a production start never adds
 * them. Nothing listening there costs a second at the start (the client waits that long for a first connection), then
 * it retries in the background.
 */
const DevToolsInDev = Layer.unwrap(
  AppConfig.useSync(({ dev, devToolsUrl }) => (dev ? DevTools.layer(devToolsUrl) : Layer.empty)),
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
