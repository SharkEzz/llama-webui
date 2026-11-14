import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api';
import { ServerView } from '../server.ts';
import { ProfileNotFound } from './ProfilesApi.ts';

/** Another lifecycle operation holds the server: `operation in progress, try again`. */
export class OperationInProgress extends Schema.TaggedError<
  OperationInProgress,
  { readonly OperationInProgress: unique symbol }
>()('OperationInProgress', { message: Schema.String }, { httpApiStatus: 409 }) {}

/** A start while llama-webui runs a server: `a server is already running`. */
export class ServerAlreadyRunning extends Schema.TaggedError<
  ServerAlreadyRunning,
  { readonly ServerAlreadyRunning: unique symbol }
>()('ServerAlreadyRunning', { message: Schema.String }, { httpApiStatus: 409 }) {}

/**
 * The port of the launch answers already: `port in use by an external server (PID <pid or unknown>)` when a
 * llama-server answers there, `port <port> is in use by another service` otherwise.
 */
export class PortInUse extends Schema.TaggedError<PortInUse, { readonly PortInUse: unique symbol }>()(
  'PortInUse',
  {
    message: Schema.String,
    port: Schema.Int,
    by: Schema.Literals(['llama-server', 'other']),
    pid: Schema.NullOr(Schema.Int),
  },
  { httpApiStatus: 409 },
) {}

/** A restart with no profile launched before: `No profile to restart`. */
export class NoProfileToRestart extends Schema.TaggedError<
  NoProfileToRestart,
  { readonly NoProfileToRestart: unique symbol }
>()('NoProfileToRestart', { message: Schema.String }, { httpApiStatus: 409 }) {}

/** `/props` asked while no server answers: `Server not ready`. */
export class ServerNotReady extends Schema.TaggedError<ServerNotReady, { readonly ServerNotReady: unique symbol }>()(
  'ServerNotReady',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/**
 * llama-server did not give its `/props`: `llama-server /props: HTTP <status>`, `llama-server /props: the reply is not
 * JSON` or `llama-server is not responding on /props`.
 */
export class PropsUnavailable extends Schema.TaggedError<
  PropsUnavailable,
  { readonly PropsUnavailable: unique symbol }
>()('PropsUnavailable', { message: Schema.String }, { httpApiStatus: 502 }) {}

/** The profile to launch. */
const Launch = Schema.Struct({ profileId: Schema.Int });
/** A lifecycle operation began: its end is told by the `server-state` messages. */
const Accepted = ServerView.pipe(HttpApiSchema.status(202));

/** llama-server: its state, its lifecycle and its `/props`; and the snapshot a page reads when it opens. */
export class ServerApi extends HttpApiGroup.make('server').add(
  HttpApiEndpoint.get('state', '/api/server/state', { success: ServerView }),
  HttpApiEndpoint.post('start', '/api/server/start', {
    payload: Launch,
    success: Accepted,
    error: [ProfileNotFound, OperationInProgress, ServerAlreadyRunning, PortInUse],
  }),
  HttpApiEndpoint.post('switch', '/api/server/switch', {
    payload: Launch,
    success: Accepted,
    error: [ProfileNotFound, OperationInProgress, PortInUse],
  }),
  HttpApiEndpoint.post('restart', '/api/server/restart', {
    success: Accepted,
    error: [NoProfileToRestart, ProfileNotFound, OperationInProgress, PortInUse],
  }),
  HttpApiEndpoint.post('stop', '/api/server/stop', { success: ServerView }),
  // llama-server's own JSON, passed as it is.
  HttpApiEndpoint.get('props', '/api/server/props', {
    success: Schema.Unknown,
    error: [ServerNotReady, PropsUnavailable],
  }),
  HttpApiEndpoint.get('snapshot', '/api/state', {
    success: Schema.Struct({ server: ServerView, logSeq: Schema.Int, bootId: Schema.String }),
  }),
) {}
