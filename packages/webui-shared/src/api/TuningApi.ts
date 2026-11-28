import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from 'effect/http-api';
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
>()(
  'ModelPathInvalid',
  { message: Schema.String },
  { httpApiStatus: 400, description: 'ModelPathInvalid: Expected an absolute path ending in `.gguf`.' },
) {}

/** The projector of a request is not a file: `Projector not found`. */
export class ProjectorNotFound extends Schema.TaggedError<
  ProjectorNotFound,
  { readonly ProjectorNotFound: unique symbol }
>()(
  'ProjectorNotFound',
  { message: Schema.String },
  { httpApiStatus: 404, description: 'ProjectorNotFound: The specified multimodal projector file does not exist.' },
) {}

/** Fewer than 64 MiB to read from the model: `File too small to measure (<n> MiB)`. */
export class FileTooSmall extends Schema.TaggedError<FileTooSmall, { readonly FileTooSmall: unique symbol }>()(
  'FileTooSmall',
  { message: Schema.String },
  { httpApiStatus: 400, description: 'FileTooSmall: The GGUF file is smaller than the 64 MiB minimum sample size.' },
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
export const PlanRequest = Schema.Struct({ spec: SweepSpec }).annotate({
  identifier: 'PlanRequest',
  description: 'Sweep specification to expand and check against the memory estimator without storing anything.',
  message: 'Expected object',
  messageUnexpectedKey: 'unknown key',
});

/** The query of the checks: the model to check against, optional (empty = none). */
export const ChecksQuery = Schema.Struct({ model: Schema.optionalKey(Schema.String) });

/** The tuning tools: the system checks, the hardware, the disk speed, the memory estimate and the plan of a sweep. */
export class TuningApi extends HttpApiGroup.make('tuning')
  .add(
    HttpApiEndpoint.get('checks', '/api/tuning/checks', {
      query: ChecksQuery,
      success: ChecksReport,
      error: ModelPathRefused,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Run system tuning checks',
        description:
          'Audits GPU persistence/PCIe links, CPU governor/memlock, kernel swappiness, SIMD build flags, and optional model disk/memory checks for `?model=<path>`.',
      }),
    ),
    HttpApiEndpoint.get('hardware', '/api/tuning/hardware', { success: TuningHardware }).annotateMerge(
      OpenApi.annotations({
        summary: 'Read tuning hardware inventory',
        description: 'Returns `llama-bench` devices with live free VRAM, CPU topology, and host RAM availability.',
      }),
    ),
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
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Measure sequential disk read speed',
        description:
          'Measures direct sequential read bandwidth (`bytesPerSec`) on a GGUF file of at least 64 MiB and memoizes the result for mmap overflow projections.',
      }),
    ),
    HttpApiEndpoint.post('estimate', '/api/tuning/estimate', {
      payload: EstimateRequest,
      success: Estimate,
      error: ModelLoadErrors,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Estimate optimal flags and memory fit',
        description:
          'Computes recommended `llama-server` flags, per-GPU VRAM budgets, host RAM usage and disk read overhead for a model and preset (`chat`, `agent`, `context`, `fit`, `big`).',
      }),
    ),
    HttpApiEndpoint.post('plan', '/api/tuning/plan', {
      payload: PlanRequest,
      success: PlanResult,
      error: ModelLoadErrors,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Plan a sweep without running it',
        description:
          'Expands `spec.space` over `spec.base`, evaluates each configuration against the memory estimator, and returns the resulting items, exclusion counts and estimated duration.',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Tuning',
      description:
        'Host diagnostic checks, hardware inventory, disk read measurement, memory estimation and dry-run sweep planning.',
    }),
  ) {}
