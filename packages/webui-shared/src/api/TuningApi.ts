import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { SweepSpec } from '../sweep.ts';
import {
  ChecksReport,
  DiskSpeed,
  DiskSpeedRequest,
  Estimate,
  EstimateRequest,
  PlanResult,
  TuningHardware,
} from '../tuning.ts';
import { BenchRunning } from './BenchApi.ts';
import { ModelFileNotFound, ModelNotFound, ModelPathRefused, ModelUnreadable } from './ModelsApi.ts';

/** A model path that is not absolute or not a `.gguf`: `Expected an absolute path to a .gguf file`. */
export class ModelPathInvalid extends Schema.TaggedError<
  ModelPathInvalid,
  { readonly ModelPathInvalid: unique symbol }
>()('ModelPathInvalid', { message: Schema.String }, { httpApiStatus: 400 }) {}

/** The projector of a request is not a file: `Projector not found`. */
export class ProjectorNotFound extends Schema.TaggedError<
  ProjectorNotFound,
  { readonly ProjectorNotFound: unique symbol }
>()('ProjectorNotFound', { message: Schema.String }, { httpApiStatus: 404 }) {}

/** Fewer than 64 MiB to read from the model: `File too small to measure (<n> MiB)`. */
export class FileTooSmall extends Schema.TaggedError<FileTooSmall, { readonly FileTooSmall: unique symbol }>()(
  'FileTooSmall',
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** What loading the model of a tuning request refuses: the path (its form, then where it is), the file, the GGUF, the projector. */
export const ModelLoadErrors = [
  ModelPathInvalid,
  ModelPathRefused,
  ModelNotFound,
  ModelUnreadable,
  ProjectorNotFound,
] as const;

/** A plan asked for: the sweep's spec, nothing stored. */
export const PlanRequest = Schema.Struct({ spec: SweepSpec }).annotate({ messageUnexpectedKey: 'unknown key' });

/** The query of the checks: the model to check against, optional (empty = none). */
export const ChecksQuery = Schema.Struct({ model: Schema.optionalKey(Schema.String) });

/** The tuning tools: the system checks, the hardware, the disk speed, the memory estimate and the plan of a sweep. */
export class TuningApi extends HttpApiGroup.make('tuning').add(
  HttpApiEndpoint.get('checks', '/api/tuning/checks', {
    query: ChecksQuery,
    success: ChecksReport,
    error: ModelPathRefused,
  }),
  HttpApiEndpoint.get('hardware', '/api/tuning/hardware', { success: TuningHardware }),
  HttpApiEndpoint.post('diskSpeed', '/api/tuning/disk-speed', {
    payload: DiskSpeedRequest,
    success: DiskSpeed,
    error: [
      BenchRunning,
      ModelPathInvalid,
      ModelPathRefused,
      ModelNotFound,
      ModelUnreadable,
      ModelFileNotFound,
      FileTooSmall,
    ],
  }),
  HttpApiEndpoint.post('estimate', '/api/tuning/estimate', {
    payload: EstimateRequest,
    success: Estimate,
    error: ModelLoadErrors,
  }),
  HttpApiEndpoint.post('plan', '/api/tuning/plan', {
    payload: PlanRequest,
    success: PlanResult,
    error: ModelLoadErrors,
  }),
) {}
