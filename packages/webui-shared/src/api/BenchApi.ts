import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api';
import { BenchDevice, BenchDraft, BenchLive, BenchRun, BenchSpec } from '../bench.ts';
import { Profile } from '../profile.ts';
import { ModelPathRefused } from './ModelsApi.ts';
import { ProfileNameTaken, ProfileNotFound } from './ProfilesApi.ts';
import { IdParam } from './params.ts';

/** A run, a sweep, or a request between its acceptance and its start already holds the bench: `A benchmark is running`. */
export class BenchRunning extends Schema.TaggedError<BenchRunning, { readonly BenchRunning: unique symbol }>()(
  'BenchRunning',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** A file of the spec is not on disk: `Model not found: <path>` or `Projector not found: <path>`. */
export class BenchFileMissing extends Schema.TaggedError<
  BenchFileMissing,
  { readonly BenchFileMissing: unique symbol }
>()('BenchFileMissing', { message: Schema.String }, { httpApiStatus: 404 }) {}

/** A stop of llama-server in progress lasts too long: `llama-server is taking too long to stop: try again`. */
export class ServerStopTooSlow extends Schema.TaggedError<
  ServerStopTooSlow,
  { readonly ServerStopTooSlow: unique symbol }
>()('ServerStopTooSlow', { message: Schema.String }, { httpApiStatus: 409 }) {}

/** A llama-server not started by llama-webui holds the port: `An external llama-server is running on port <port>: stop it first`. */
export class ExternalServerRunning extends Schema.TaggedError<
  ExternalServerRunning,
  { readonly ExternalServerRunning: unique symbol }
>()('ExternalServerRunning', { message: Schema.String }, { httpApiStatus: 409 }) {}

/**
 * llama-server runs and the request did not ask to stop it:
 * `llama-server is running (profile <name>): it will be stopped during the benchmark, then restarted`.
 */
export class ServerRunning extends Schema.TaggedError<ServerRunning, { readonly ServerRunning: unique symbol }>()(
  'ServerRunning',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** No run has this id: `Run not found`. */
export class RunNotFound extends Schema.TaggedError<RunNotFound, { readonly RunNotFound: unique symbol }>()(
  'RunNotFound',
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The run is running: `This run is still running: cancel it first` (delete), `This run is still running` (to-profile). */
export class RunStillRunning extends Schema.TaggedError<RunStillRunning, { readonly RunStillRunning: unique symbol }>()(
  'RunStillRunning',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** A cancel of a run that is not the current one: `This run is not running`. */
export class RunNotRunning extends Schema.TaggedError<RunNotRunning, { readonly RunNotRunning: unique symbol }>()(
  'RunNotRunning',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The refusals of anything that takes the bench: busy, a missing file, the three of the gate. */
export const BenchStartErrors = [
  BenchRunning,
  BenchFileMissing,
  ServerStopTooSlow,
  ExternalServerRunning,
  ServerRunning,
] as const;

const params = { id: IdParam };

/** A run asked for: its spec, and whether llama-server may be stopped for it (only `true` counts). */
export const BenchRunRequest = Schema.Struct({
  spec: BenchSpec,
  stopServer: Schema.optionalKey(Schema.Boolean),
}).annotate({ messageUnexpectedKey: 'unknown key' });

/**
 * The query of the runs list, lenient: every key optional, any string; `runFilters` of the server reads them (an
 * unknown kind or status is ignored, `sweep` absent or unknown = the one-off runs).
 */
export const RunsQuery = Schema.Struct({
  kind: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  sweep: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.String),
});
export type RunsQuery = typeof RunsQuery.Type;

const failedOnly = '?failed=1 expected';

/** The benchmarks: the devices, a draft from a profile, the runs, a run, its cancel, its deletion, a profile from it. */
export class BenchApi extends HttpApiGroup.make('bench').add(
  HttpApiEndpoint.get('devices', '/api/bench/devices', { success: Schema.Array(BenchDevice) }),
  HttpApiEndpoint.get('fromProfile', '/api/bench/from-profile/:id', {
    params,
    success: BenchDraft,
    error: ProfileNotFound,
  }),
  HttpApiEndpoint.get('runs', '/api/bench/runs', {
    query: RunsQuery,
    success: Schema.Struct({ runs: Schema.Array(BenchRun), live: Schema.NullOr(BenchLive) }),
  }),
  // The failed, cancelled and interrupted one-off runs leave the history; the ids removed are counted.
  HttpApiEndpoint.delete('deleteFailed', '/api/bench/runs', {
    query: Schema.Struct({
      failed: Schema.Literal('1')
        .annotate({ message: failedOnly })
        .pipe(Schema.annotateKey({ messageMissingKey: failedOnly })),
    }),
    success: Schema.Struct({ deleted: Schema.Int }),
  }),
  HttpApiEndpoint.post('run', '/api/bench/run', {
    payload: BenchRunRequest,
    success: BenchRun.pipe(HttpApiSchema.status(202)),
    error: [ModelPathRefused, ...BenchStartErrors],
  }),
  HttpApiEndpoint.delete('remove', '/api/bench/:id', { params, error: [RunNotFound, RunStillRunning] }),
  HttpApiEndpoint.post('cancel', '/api/bench/:id/cancel', { params, error: [RunNotFound, RunNotRunning] }),
  HttpApiEndpoint.post('toProfile', '/api/bench/:id/to-profile', {
    params,
    success: Profile.pipe(HttpApiSchema.status(201)),
    error: [RunNotFound, RunStillRunning, ProfileNameTaken],
  }),
) {}
