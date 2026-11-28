import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from 'effect/http-api';
import { ModelDelete, ModelDeleted, ModelDetail, ModelList, ModelUsage } from '../models.ts';
import { ProfileRunning } from './ProfilesApi.ts';

/** No model of the models folder has this path: `Model not found`. */
export class ModelNotFound extends Schema.TaggedError<ModelNotFound, { readonly ModelNotFound: unique symbol }>()(
  'ModelNotFound',
  { message: Schema.String },
  {
    httpApiStatus: 404,
    description: 'ModelNotFound: No GGUF model matching this path was found in the models folder.',
  },
) {}

/** No file has the path of `GET /api/models/info`: `File not found`. */
export class ModelFileNotFound extends Schema.TaggedError<
  ModelFileNotFound,
  { readonly ModelFileNotFound: unique symbol }
>()(
  'ModelFileNotFound',
  { message: Schema.String },
  { httpApiStatus: 404, description: 'ModelFileNotFound: The requested GGUF file does not exist on disk.' },
) {}

/**
 * A model or projector path of a request that is neither under the models folder nor the model or projector of a
 * profile: `Outside the models folder and not used by a profile`.
 */
export class ModelPathRefused extends Schema.TaggedError<
  ModelPathRefused,
  { readonly ModelPathRefused: unique symbol }
>()(
  'ModelPathRefused',
  { message: Schema.String },
  {
    httpApiStatus: 403,
    description: 'ModelPathRefused: Path is outside the configured models folder and not referenced by any profile.',
  },
) {}

/** The file is not a GGUF that can be read: the read error's message (`unreadable GGUF: …`, `permission denied: …`). */
export class ModelUnreadable extends Schema.TaggedError<ModelUnreadable, { readonly ModelUnreadable: unique symbol }>()(
  'ModelUnreadable',
  { message: Schema.String },
  { httpApiStatus: 422, description: 'ModelUnreadable: The file exists on disk but cannot be parsed as a valid GGUF.' },
) {}

/**
 * A deletion of a model something uses: `The running server uses it (profile “<name>”): stop it first`,
 * `A download in progress writes it` or `A benchmark in progress uses it`.
 */
export class ModelInUse extends Schema.TaggedError<ModelInUse, { readonly ModelInUse: unique symbol }>()(
  'ModelInUse',
  { message: Schema.String },
  {
    httpApiStatus: 409,
    description: 'ModelInUse: The model is actively used by llama-server, an active download, or a running benchmark.',
  },
) {}

/** A path of the query: `path required` when it is missing or empty. */
const RequiredPath = Schema.String.check(Schema.isMinLength(1, { message: 'path required' })).pipe(
  Schema.annotateKey({ messageMissingKey: 'path required' }),
);

const absoluteGguf = 'Absolute path to a .gguf file expected';
/** The path of a GGUF: under the models folder, or a profile's (else `ModelPathRefused`). */
const GgufPath = Schema.String.check(Schema.isPattern(/^\/.*\.gguf$/su, { message: absoluteGguf })).pipe(
  Schema.annotateKey({ messageMissingKey: absoluteGguf }),
);

/** The GGUFs of the models folder: the list (read again on every call), the detail of one, its usage, its deletion. */
export class ModelsApi extends HttpApiGroup.make('models')
  .add(
    HttpApiEndpoint.get('list', '/api/models', { success: ModelList }).annotateMerge(
      OpenApi.annotations({
        summary: 'Scan local GGUF models',
        description:
          'Scans the configured `modelsDir` recursively, groups multi-shard GGUF files, uses SQLite header caching (`model_cache`) and prunes missing entries.',
      }),
    ),
    HttpApiEndpoint.delete('remove', '/api/models', {
      payload: ModelDelete,
      success: ModelDeleted,
      error: [ModelNotFound, ModelInUse, ProfileRunning],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Delete a local GGUF model',
        description:
          'Deletes all shards of a model inside `modelsDir`, removes empty parent folders up to `modelsDir`, and optionally deletes referencing profiles (`deleteProfiles: true`).',
      }),
    ),
    HttpApiEndpoint.get('info', '/api/models/info', {
      query: { path: GgufPath },
      success: ModelDetail,
      error: [ModelPathRefused, ModelFileNotFound, ModelUnreadable],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Inspect one GGUF file',
        description:
          'Parses full tensor headers and weight breakdowns for an absolute `.gguf` path inside `modelsDir` or referenced by a saved profile.',
      }),
    ),
    HttpApiEndpoint.get('usage', '/api/models/usage', {
      query: { path: RequiredPath },
      success: ModelUsage,
      error: ModelNotFound,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Check model usage before deletion',
        description:
          'Lists every shard file, every referencing profile, and any active blocker (running server, download or benchmark) for a model in `modelsDir`.',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Models',
      description: 'Local GGUF discovery, tensor/weight inspection, reference tracking, and safe deletion.',
    }),
  ) {}
