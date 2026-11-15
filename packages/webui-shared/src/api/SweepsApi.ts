import { Effect, Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api';
import { BenchRun } from '../bench.ts';
import { Sweep, SweepLive } from '../sweep.ts';
import { BenchStartErrors } from './BenchApi.ts';
import { IdParam } from './params.ts';

/** No sweep has this id: `Sweep not found`. */
export class SweepNotFound extends Schema.TaggedError<SweepNotFound, { readonly SweepNotFound: unique symbol }>()(
  'SweepNotFound',
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The sweep is running: `This sweep is still running: cancel it first`. */
export class SweepStillRunning extends Schema.TaggedError<
  SweepStillRunning,
  { readonly SweepStillRunning: unique symbol }
>()('SweepStillRunning', { message: Schema.String }, { httpApiStatus: 409 }) {}

/** A cancel of a sweep that is not running: `This sweep is not running`. */
export class SweepNotRunning extends Schema.TaggedError<SweepNotRunning, { readonly SweepNotRunning: unique symbol }>()(
  'SweepNotRunning',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** A resume of a sweep with no item left: `Nothing to resume: no interrupted or queued item`. */
export class NothingToResume extends Schema.TaggedError<NothingToResume, { readonly NothingToResume: unique symbol }>()(
  'NothingToResume',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** A validation of a sweep without a successful run: `No successful run to validate`. */
export class NothingToValidate extends Schema.TaggedError<
  NothingToValidate,
  { readonly NothingToValidate: unique symbol }
>()('NothingToValidate', { message: Schema.String }, { httpApiStatus: 409 }) {}

/** A validation: the `n` best llama-bench items replayed on llama-server (1 to 5, 3 by default). */
export const ValidateRequest = Schema.Struct({
  n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(3)),
  ),
  stopServer: Schema.optionalKey(Schema.Boolean),
}).annotate({ messageUnexpectedKey: 'unknown key' });

const params = { id: IdParam };

/** The sweeps: the list, one with its runs, its deletion, its cancel, its resume, its validation. */
export class SweepsApi extends HttpApiGroup.make('sweeps').add(
  HttpApiEndpoint.get('list', '/api/sweeps', {
    success: Schema.Struct({ sweeps: Schema.Array(Sweep), live: Schema.NullOr(SweepLive) }),
  }),
  HttpApiEndpoint.get('get', '/api/sweeps/:id', {
    params,
    success: Schema.Struct({ sweep: Sweep, runs: Schema.Array(BenchRun) }),
    error: SweepNotFound,
  }),
  HttpApiEndpoint.delete('remove', '/api/sweeps/:id', { params, error: [SweepNotFound, SweepStillRunning] }),
  HttpApiEndpoint.post('cancel', '/api/sweeps/:id/cancel', { params, error: [SweepNotFound, SweepNotRunning] }),
  // The body is read as it is: only `stopServer: true` counts, any other key is ignored.
  HttpApiEndpoint.post('resume', '/api/sweeps/:id/resume', {
    params,
    payload: Schema.Record(Schema.String, Schema.Unknown),
    success: Sweep.pipe(HttpApiSchema.status(202)),
    error: [SweepNotFound, SweepStillRunning, ...BenchStartErrors, NothingToResume],
  }),
  HttpApiEndpoint.post('validate', '/api/sweeps/:id/validate', {
    params,
    payload: ValidateRequest,
    success: Sweep.pipe(HttpApiSchema.status(202)),
    error: [SweepNotFound, SweepStillRunning, ...BenchStartErrors, NothingToValidate],
  }),
) {}
