import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from 'effect/http-api';
import { BenchDevice, BenchDraft, BenchLive, BenchRun, BenchSpec } from '../bench.ts';
import { Profile } from '../profile.ts';
import { ModelPathRefused } from './ModelsApi.ts';
import { IdParam } from './params.ts';
import { ProfileNameTaken, ProfileNotFound } from './ProfilesApi.ts';

/** A run, a sweep, or a request between its acceptance and its start already holds the bench: `A benchmark is running`. */
export class BenchRunning extends Schema.TaggedError<BenchRunning, { readonly BenchRunning: unique symbol }>()(
  'BenchRunning',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'BenchRunning: A benchmark run or sweep already holds the GPUs.' },
) {}

/** A file of the spec is not on disk: `Model not found: <path>` or `Projector not found: <path>`. */
export class BenchFileMissing extends Schema.TaggedError<
  BenchFileMissing,
  { readonly BenchFileMissing: unique symbol }
>()(
  'BenchFileMissing',
  { message: Schema.String },
  {
    httpApiStatus: 404,
    description: 'BenchFileMissing: The model or projector path in the spec does not exist on disk.',
  },
) {}

/** A stop of llama-server in progress lasts too long: `llama-server is taking too long to stop: try again`. */
export class ServerStopTooSlow extends Schema.TaggedError<
  ServerStopTooSlow,
  { readonly ServerStopTooSlow: unique symbol }
>()(
  'ServerStopTooSlow',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'ServerStopTooSlow: An in-progress llama-server stop did not finish in time.' },
) {}

/** A llama-server not started by llama-webui holds the port: `An external llama-server is running on port <port>: stop it first`. */
export class ExternalServerRunning extends Schema.TaggedError<
  ExternalServerRunning,
  { readonly ExternalServerRunning: unique symbol }
>()(
  'ExternalServerRunning',
  { message: Schema.String },
  {
    httpApiStatus: 409,
    description: 'ExternalServerRunning: An unmanaged llama-server holds the port and must be stopped manually first.',
  },
) {}

/**
 * llama-server runs and the request did not ask to stop it:
 * `llama-server is running (profile <name>): it will be stopped during the benchmark, then restarted`.
 */
export class ServerRunning extends Schema.TaggedError<ServerRunning, { readonly ServerRunning: unique symbol }>()(
  'ServerRunning',
  { message: Schema.String },
  {
    httpApiStatus: 409,
    description:
      'ServerRunning: Managed llama-server is running; resend with `stopServer: true` to stop and restore it.',
  },
) {}

/** No run has this id: `Run not found`. */
export class RunNotFound extends Schema.TaggedError<RunNotFound, { readonly RunNotFound: unique symbol }>()(
  'RunNotFound',
  { message: Schema.String },
  { httpApiStatus: 404, description: 'RunNotFound: No benchmark run exists with the given id.' },
) {}

/** The run is running: `This run is still running: cancel it first` (delete), `This run is still running` (to-profile). */
export class RunStillRunning extends Schema.TaggedError<RunStillRunning, { readonly RunStillRunning: unique symbol }>()(
  'RunStillRunning',
  { message: Schema.String },
  {
    httpApiStatus: 409,
    description: 'RunStillRunning: The run is still executing and cannot be deleted or converted yet.',
  },
) {}

/** A cancel of a run that is not the current one: `This run is not running`. */
export class RunNotRunning extends Schema.TaggedError<RunNotRunning, { readonly RunNotRunning: unique symbol }>()(
  'RunNotRunning',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'RunNotRunning: The specified run is not currently active.' },
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
}).annotate({
  identifier: 'BenchRunRequest',
  description:
    'Benchmark run request payload; set `stopServer: true` to temporarily stop a running managed llama-server.',
  message: 'Expected object',
  messageUnexpectedKey: 'unknown key',
});

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
export class BenchApi extends HttpApiGroup.make('bench')
  .add(
    HttpApiEndpoint.get('devices', '/api/bench/devices', { success: Schema.Array(BenchDevice) }).annotateMerge(
      OpenApi.annotations({
        summary: 'List benchmark devices',
        description:
          'Returns compute devices reported by `llama-bench --list-devices` (cached per binary), enriched with live free and other-process VRAM.',
      }),
    ),
    HttpApiEndpoint.get('fromProfile', '/api/bench/from-profile/:id', {
      params,
      success: BenchDraft,
      error: ProfileNotFound,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Build a benchmark draft from a profile',
        description:
          'Splits a saved profile into `BenchParams` and remaining `serverArgs` so it can pre-fill a benchmark or sweep form.',
      }),
    ),
    HttpApiEndpoint.get('runs', '/api/bench/runs', {
      query: RunsQuery,
      success: Schema.Struct({ runs: Schema.Array(BenchRun), live: Schema.NullOr(BenchLive) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List benchmark runs',
        description:
          'Lists persisted runs filtered by optional `kind`, `status`, `model`, `sweep` (omitted = one-off runs, `all`, or sweep id), and `limit` (capped at 10,000), along with `live` progress.',
      }),
    ),
    // The failed, cancelled and interrupted one-off runs leave the history; the ids removed are counted.
    HttpApiEndpoint.delete('deleteFailed', '/api/bench/runs', {
      query: Schema.Struct({
        failed: Schema.Literal('1')
          .annotate({ message: failedOnly })
          .pipe(Schema.annotateKey({ messageMissingKey: failedOnly })),
      }),
      success: Schema.Struct({ deleted: Schema.Int }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Delete failed one-off runs',
        description:
          'Requires `?failed=1`. Deletes all one-off runs in status `failed`, `cancelled`, or `interrupted` (sweep items are preserved) and broadcasts `bench-deleted`.',
      }),
    ),
    HttpApiEndpoint.post('run', '/api/bench/run', {
      payload: BenchRunRequest,
      success: BenchRun.pipe(HttpApiSchema.status(202)),
      error: [ModelPathRefused, ...BenchStartErrors],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Start a benchmark run',
        description:
          'Acquires the server gate (stopping and later restarting a managed `llama-server` when `stopServer: true`), persists the run and starts it in the background (`202 Accepted`).',
      }),
    ),
    HttpApiEndpoint.delete('remove', '/api/bench/:id', { params, error: [RunNotFound, RunStillRunning] }).annotateMerge(
      OpenApi.annotations({
        summary: 'Delete a benchmark run',
        description:
          'Deletes one benchmark run (one-off or sweep item) and broadcasts `bench-deleted` (`204 No Content`).',
      }),
    ),
    HttpApiEndpoint.post('cancel', '/api/bench/:id/cancel', {
      params,
      error: [RunNotFound, RunNotRunning],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Cancel a running benchmark',
        description:
          'Stops the active benchmark process (`SIGTERM`, escalating to `SIGKILL`), records status `cancelled`, releases the server gate, and returns `204 No Content`.',
      }),
    ),
    HttpApiEndpoint.post('toProfile', '/api/bench/:id/to-profile', {
      params,
      success: Profile.pipe(HttpApiSchema.status(201)),
      error: [RunNotFound, RunStillRunning, ProfileNameTaken],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Create a profile from a run',
        description: 'Saves a completed benchmark run configuration as a new `ui` profile (`201 Created`).',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Benchmarks',
      description:
        'Single `llama-bench` and trial `llama-server` benchmarks. Only one benchmark or sweep runs at a time; starting one acquires the server gate and automatically restarts any stopped managed `llama-server` afterward.',
    }),
  ) {}
