import { Layer } from 'effect';
import { AppInfo } from './config/AppInfo.ts';
import { HttpLive } from './http/HttpLive.ts';

/** The whole application but its configuration: the HTTP server on the services it uses. Later tasks add theirs. */
export const App = HttpLive.pipe(Layer.provide(AppInfo.layer));
