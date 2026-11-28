import { Effect, Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from 'effect/http-api';
import { BenchRun } from '../bench.ts';
import { Sweep, SweepLive, SweepSpec } from '../sweep.ts';
import { BenchStartErrors } from './BenchApi.ts';
import { IdParam } from './params.ts';
import { ModelLoadErrors } from './TuningApi.ts';

/** No sweep has this id: `Sweep not found`. */
export class SweepNotFound extends Schema.TaggedError<SweepNotFound, { readonly SweepNotFound: unique symbol }>()(
  'SweepNotFound',
  { message: Schema.String },
  { httpApiStatus: 404, description: 'SweepNotFound: No sweep exists with the given id.' },
) {}

/** The sweep is running: `This sweep is still running: cancel it first`. */
export class SweepStillRunning extends Schema.TaggedError<
  SweepStillRunning,
  { readonly SweepStillRunning: unique symbol }
>()(
  'SweepStillRunning',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'SweepStillRunning: The sweep is currently running and must be cancelled first.' },
) {}

/** A cancel of a sweep that is not running: `This sweep is not running`. */
export class SweepNotRunning extends Schema.TaggedError<SweepNotRunning, { readonly SweepNotRunning: unique symbol }>()(
  'SweepNotRunning',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'SweepNotRunning: The specified sweep is not currently running.' },
) {}

/** A resume of a sweep with no item left: `Nothing to resume: no interrupted or queued item`. */
export class NothingToResume extends Schema.TaggedError<NothingToResume, { readonly NothingToResume: unique symbol }>()(
  'NothingToResume',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'NothingToResume: The sweep has no queued or interrupted items remaining.' },
) {}

/** A validation of a sweep without a successful run: `No successful run to validate`. */
export class NothingToValidate extends Schema.TaggedError<
  NothingToValidate,
  { readonly NothingToValidate: unique symbol }
>()(
  'NothingToValidate',
  { message: Schema.String },
  {
    httpApiStatus: 409,
    description: 'NothingToValidate: The sweep has no successful `bench` runs to replay on llama-server.',
  },
) {}

/** A creation whose every item the estimator excludes: `No configuration to run: <n> excluded by the estimator`. */
export class NothingToRun extends Schema.TaggedError<NothingToRun, { readonly NothingToRun: unique symbol }>()(
  'NothingToRun',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'NothingToRun: Every planned combination was excluded by the memory estimator.' },
) {}

/** A sweep asked for: its spec, and whether llama-server may be stopped for it (only `true` counts). */
export const SweepRequest = Schema.Struct({
  spec: SweepSpec,
  stopServer: Schema.optionalKey(Schema.Boolean),
}).annotate({
  identifier: 'SweepRequest',
  description: 'Request payload to plan and launch a parameter sweep.',
  message: 'Expected object',
  messageUnexpectedKey: 'unknown key',
});

/** A validation: the `n` best llama-bench items replayed on llama-server (1 to 5, 3 by default). */
export const ValidateRequest = Schema.Struct({
  n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(3)),
  ),
  stopServer: Schema.optionalKey(Schema.Boolean),
}).annotate({
  identifier: 'ValidateRequest',
  description:
    'Request payload to validate the top `n` (1–5, default 3) `llama-bench` items on a trial `llama-server`.',
  message: 'Expected object',
  messageUnexpectedKey: 'unknown key',
});

const params = { id: IdParam };

/**
 * The sweeps: the list, the creation (the plan of `POST /api/tuning/plan`, then the runner), one with its runs, its
 * deletion, its cancel, its resume, its validation.
 */
export class SweepsApi extends HttpApiGroup.make('sweeps')
  .add(
    HttpApiEndpoint.get('list', '/api/sweeps', {
      success: Schema.Struct({ sweeps: Schema.Array(Sweep), live: Schema.NullOr(SweepLive) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List sweeps',
        description: 'Returns all persisted sweeps newest first together with `live` progress if one is running.',
      }),
    ),
    HttpApiEndpoint.post('create', '/api/sweeps', {
      payload: SweepRequest,
      success: Schema.Struct({ sweep: Sweep, items: Schema.Int, excluded: Schema.Int }).pipe(HttpApiSchema.status(202)),
      error: [...ModelLoadErrors, ...BenchStartErrors, NothingToRun],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Create and start a sweep',
        description:
          'Expands and filters combinations with the memory estimator, acquires the server gate, persists the sweep and its queued items, and starts exploration (`202 Accepted`). Nothing is saved if refused.',
      }),
    ),
    HttpApiEndpoint.get('get', '/api/sweeps/:id', {
      params,
      success: Schema.Struct({ sweep: Sweep, runs: Schema.Array(BenchRun) }),
      error: SweepNotFound,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Get a sweep and its runs',
        description: 'Returns one sweep and all its `BenchRun` items in item order.',
      }),
    ),
    HttpApiEndpoint.delete('remove', '/api/sweeps/:id', {
      params,
      error: [SweepNotFound, SweepStillRunning],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Delete a sweep',
        description: 'Deletes a finished or stopped sweep and all of its runs (`204 No Content`).',
      }),
    ),
    HttpApiEndpoint.post('cancel', '/api/sweeps/:id/cancel', {
      params,
      error: [SweepNotFound, SweepNotRunning],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Cancel a running sweep',
        description:
          'Stops the current item, marks remaining items cancelled, releases the server gate (`204 No Content`).',
      }),
    ),
    // The body is read as it is: only `stopServer: true` counts, any other key is ignored.
    HttpApiEndpoint.post('resume', '/api/sweeps/:id/resume', {
      params,
      payload: Schema.Record(Schema.String, Schema.Unknown),
      success: Sweep.pipe(HttpApiSchema.status(202)),
      error: [SweepNotFound, SweepStillRunning, ...BenchStartErrors, NothingToResume],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Resume an interrupted sweep',
        description:
          'Re-acquires the server gate and continues running queued or interrupted items of the sweep (`202 Accepted`). Pass `{ "stopServer": true }` to allow stopping a managed server.',
      }),
    ),
    HttpApiEndpoint.post('validate', '/api/sweeps/:id/validate', {
      params,
      payload: ValidateRequest,
      success: Sweep.pipe(HttpApiSchema.status(202)),
      error: [SweepNotFound, SweepStillRunning, ...BenchStartErrors, NothingToValidate],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Validate top sweep results on llama-server',
        description:
          'Replays the top `n` (1–5) ranked `llama-bench` configurations on a trial `llama-server` to measure real serving throughput (`202 Accepted`).',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Sweeps',
      description:
        'Multi-configuration parameter sweeps (`llama-bench` exploration followed by optional `llama-server` validation). Shares the exclusive server gate with Benchmarks and broadcasts `sweep`, `sweep-progress` and `sweep-deleted` over `/ws`.',
    }),
  ) {}
