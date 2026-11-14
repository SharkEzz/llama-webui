import { Layer } from 'effect';
import { AppInfo } from './config/AppInfo.ts';
import * as Db from './db/Db.ts';
import { HttpLive } from './http/HttpLive.ts';
import { Shutdown } from './runtime/Shutdown.ts';

/**
 * The services the routes use, built before the HTTP server opens its port and undone after it closed: the database
 * is opened (and brought up to date) first. Later tasks add theirs, each on `Shutdown.layer`.
 */
const Services = Layer.mergeAll(AppInfo.layer, Db.layer);

/** The HTTP server on the services it uses. */
const Http = HttpLive.pipe(Layer.provide(Services));

/**
 * The whole application but its configuration. `Shutdown.layerRunner` is built last, so its finalizer is the first
 * to run when the app stops: the shutdown steps run while the HTTP server still serves and clients are connected.
 */
export const App = Shutdown.layerRunner.pipe(Layer.provide(Http), Layer.provide(Shutdown.layer));
