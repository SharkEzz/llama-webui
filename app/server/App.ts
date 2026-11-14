import { Layer } from 'effect';
import { AppInfo } from './config/AppInfo.ts';
import { HttpLive } from './http/HttpLive.ts';
import { Shutdown } from './runtime/Shutdown.ts';

/** The HTTP server on the services it uses. Later tasks add theirs, each on `Shutdown.layer`. */
const Http = HttpLive.pipe(Layer.provide(AppInfo.layer));

/**
 * The whole application but its configuration. `Shutdown.layerRunner` is built last, so its finalizer is the first
 * to run when the app stops: the shutdown steps run while the HTTP server still serves and clients are connected.
 */
export const App = Shutdown.layerRunner.pipe(Layer.provide(Http), Layer.provide(Shutdown.layer));
