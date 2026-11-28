import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from 'effect/http-api';
import { ServerProps, ServerView } from '../server.ts';
import { BenchRunning } from './BenchApi.ts';
import { ProfileNotFound } from './ProfilesApi.ts';

/** Another lifecycle operation holds the server: `operation in progress, try again`. */
export class OperationInProgress extends Schema.TaggedError<
  OperationInProgress,
  { readonly OperationInProgress: unique symbol }
>()(
  'OperationInProgress',
  { message: Schema.String },
  {
    httpApiStatus: 409,
    description: 'OperationInProgress: Another start, stop, switch or restart is already running.',
  },
) {}

/** A start while llama-webui runs a server: `a server is already running`. */
export class ServerAlreadyRunning extends Schema.TaggedError<
  ServerAlreadyRunning,
  { readonly ServerAlreadyRunning: unique symbol }
>()(
  'ServerAlreadyRunning',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'ServerAlreadyRunning: A supervised llama-server is already running.' },
) {}

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
  {
    httpApiStatus: 409,
    description: 'PortInUse: The target port is already bound by an external llama-server or another process.',
  },
) {}

/** A restart with no profile launched before: `No profile to restart`. */
export class NoProfileToRestart extends Schema.TaggedError<
  NoProfileToRestart,
  { readonly NoProfileToRestart: unique symbol }
>()(
  'NoProfileToRestart',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'NoProfileToRestart: No profile has been launched yet to restart.' },
) {}

/** `/props` asked while no server answers: `Server not ready`. */
export class ServerNotReady extends Schema.TaggedError<ServerNotReady, { readonly ServerNotReady: unique symbol }>()(
  'ServerNotReady',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'ServerNotReady: No ready, sleeping or external llama-server is answering.' },
) {}

/**
 * llama-server did not give its `/props`: `llama-server /props: HTTP <status>`, `llama-server /props: the reply is not
 * JSON` or `llama-server is not responding on /props`.
 */
export class PropsUnavailable extends Schema.TaggedError<
  PropsUnavailable,
  { readonly PropsUnavailable: unique symbol }
>()(
  'PropsUnavailable',
  { message: Schema.String },
  { httpApiStatus: 502, description: 'PropsUnavailable: Upstream llama-server failed to answer valid JSON on /props.' },
) {}

/** The profile to launch. */
const Launch = Schema.Struct({ profileId: Schema.Int }).annotate({
  identifier: 'LaunchRequest',
  description: 'Identifier of the profile to start or switch to.',
  message: 'Expected object',
});
/** A lifecycle operation began: its end is told by the `server-state` messages. */
const Accepted = ServerView.pipe(HttpApiSchema.status(202));

/** llama-server: its state, its lifecycle and its `/props`; and the snapshot a page reads when it opens. */
export class ServerApi extends HttpApiGroup.make('server')
  .add(
    HttpApiEndpoint.get('state', '/api/server/state', { success: ServerView }).annotateMerge(
      OpenApi.annotations({
        summary: 'Get llama-server state',
        description: 'Returns the current supervisor `ServerView` (state, last launch command, and profile ID).',
      }),
    ),
    HttpApiEndpoint.post('start', '/api/server/start', {
      payload: Launch,
      success: Accepted,
      error: [ProfileNotFound, BenchRunning, OperationInProgress, ServerAlreadyRunning, PortInUse],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Start llama-server',
        description:
          'Starts `llama-server` with the given profile (`202 Accepted`). Lifecycle progress is pushed over `/ws` as `server-state` messages.',
      }),
    ),
    HttpApiEndpoint.post('switch', '/api/server/switch', {
      payload: Launch,
      success: Accepted,
      error: [ProfileNotFound, BenchRunning, OperationInProgress, PortInUse],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Switch profile',
        description: 'Stops any running supervised `llama-server` and starts the requested profile (`202 Accepted`).',
      }),
    ),
    HttpApiEndpoint.post('restart', '/api/server/restart', {
      success: Accepted,
      error: [BenchRunning, NoProfileToRestart, ProfileNotFound, OperationInProgress, PortInUse],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Restart llama-server',
        description:
          'Re-reads the last launched profile from SQLite, stops the current server if running, and relaunches it (`202 Accepted`).',
      }),
    ),
    HttpApiEndpoint.post('stop', '/api/server/stop', { success: ServerView, error: BenchRunning }).annotateMerge(
      OpenApi.annotations({
        summary: 'Stop llama-server',
        description:
          'Stops the supervised `llama-server` (`SIGTERM`, escalating to `SIGKILL` after 5 s) and returns the resulting `ServerView`.',
      }),
    ),
    // llama-server's own JSON: the fields the app reads typed, the others passed as they are.
    HttpApiEndpoint.get('props', '/api/server/props', {
      success: ServerProps,
      error: [ServerNotReady, PropsUnavailable],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Read llama-server /props',
        description: 'Proxies `/props` from the active (managed or external) `llama-server` instance.',
      }),
    ),
    HttpApiEndpoint.get('snapshot', '/api/state', {
      success: Schema.Struct({ server: ServerView, logSeq: Schema.Int, bootId: Schema.String }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Get initial app state snapshot',
        description:
          'Returns the current `ServerView`, next log sequence number (`logSeq`), and process `bootId` in one request for client bootstrap and resync.',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Server',
      description: 'Lifecycle control, `/props` proxy, and state bootstrap for the supervised `llama-server`.',
    }),
  ) {}
