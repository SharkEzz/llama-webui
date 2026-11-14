import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { ModelDelete, ModelDeleted, ModelDetail, ModelList, ModelUsage } from '../models.ts';
import { ProfileRunning } from './ProfilesApi.ts';

/** No model of the models folder has this path: `Model not found`. */
export class ModelNotFound extends Schema.TaggedError<ModelNotFound, { readonly ModelNotFound: unique symbol }>()(
  'ModelNotFound',
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** No file has the path of `GET /api/models/info`: `File not found`. */
export class ModelFileNotFound extends Schema.TaggedError<
  ModelFileNotFound,
  { readonly ModelFileNotFound: unique symbol }
>()('ModelFileNotFound', { message: Schema.String }, { httpApiStatus: 404 }) {}

/** The file is not a GGUF that can be read: the read error's message (`unreadable GGUF: …`, `permission denied: …`). */
export class ModelUnreadable extends Schema.TaggedError<ModelUnreadable, { readonly ModelUnreadable: unique symbol }>()(
  'ModelUnreadable',
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/**
 * A deletion of a model something uses: `The running server uses it (profile “<name>”): stop it first` or
 * `A download in progress writes it`.
 */
export class ModelInUse extends Schema.TaggedError<ModelInUse, { readonly ModelInUse: unique symbol }>()(
  'ModelInUse',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** A path of the query: `path required` when it is missing or empty. */
const RequiredPath = Schema.String.check(Schema.isMinLength(1, { message: 'path required' })).pipe(
  Schema.annotateKey({ messageMissingKey: 'path required' }),
);

const absoluteGguf = 'Absolute path to a .gguf file expected';
/** The path of a GGUF anywhere on the machine (the detail is not confined to the models folder). */
const GgufPath = Schema.String.check(Schema.isPattern(/^\/.*\.gguf$/su, { message: absoluteGguf })).pipe(
  Schema.annotateKey({ messageMissingKey: absoluteGguf }),
);

/** The GGUFs of the models folder: the list (read again on every call), the detail of one, its usage, its deletion. */
export class ModelsApi extends HttpApiGroup.make('models').add(
  HttpApiEndpoint.get('list', '/api/models', { success: ModelList }),
  HttpApiEndpoint.delete('remove', '/api/models', {
    payload: ModelDelete,
    success: ModelDeleted,
    error: [ModelNotFound, ModelInUse, ProfileRunning],
  }),
  HttpApiEndpoint.get('info', '/api/models/info', {
    query: { path: GgufPath },
    success: ModelDetail,
    error: [ModelFileNotFound, ModelUnreadable],
  }),
  HttpApiEndpoint.get('usage', '/api/models/usage', {
    query: { path: RequiredPath },
    success: ModelUsage,
    error: ModelNotFound,
  }),
) {}
