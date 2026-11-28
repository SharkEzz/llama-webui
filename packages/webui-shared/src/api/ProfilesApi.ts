import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from 'effect/http-api';
import { Profile, ProfileExport, ProfileInput } from '../profile.ts';
import { IdParam } from './params.ts';

/** No profile has this id: `Profile not found`. */
export class ProfileNotFound extends Schema.TaggedError<ProfileNotFound, { readonly ProfileNotFound: unique symbol }>()(
  'ProfileNotFound',
  { message: Schema.String },
  { httpApiStatus: 404, description: 'ProfileNotFound: No profile exists with the given id.' },
) {}

/** Another profile has this name: `A profile named “<name>” already exists`. */
export class ProfileNameTaken extends Schema.TaggedError<
  ProfileNameTaken,
  { readonly ProfileNameTaken: unique symbol }
>()(
  'ProfileNameTaken',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'ProfileNameTaken: Another profile already uses this exact case-sensitive name.' },
) {}

/** A deletion of the profile the running server belongs to: `This profile belongs to the running server: stop it first`. */
export class ProfileRunning extends Schema.TaggedError<ProfileRunning, { readonly ProfileRunning: unique symbol }>()(
  'ProfileRunning',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'ProfileRunning: The profile belongs to the currently running llama-server.' },
) {}

/** The file of every profile, in the import format (`llama-webui-profiles.json`). */
export const ProfilesFile = Schema.Struct({ profiles: Schema.Array(ProfileExport) }).annotate({
  identifier: 'ProfilesFile',
  description: 'Bundle of exported profiles downloaded as `llama-webui-profiles.json`.',
});

/** What an import created, and each profile it skipped with the reason. */
export const ImportResult = Schema.Struct({
  imported: Schema.Array(Profile),
  skipped: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
}).annotate({
  identifier: 'ImportResult',
  description: 'Summary of profiles created by an import and entries skipped with their rejection reason.',
});

const Created = Profile.pipe(HttpApiSchema.status(201));
const params = { id: IdParam };

/** The launch profiles: their list, each one by id, the exports and the imports. */
export class ProfilesApi extends HttpApiGroup.make('profiles')
  .add(
    HttpApiEndpoint.get('list', '/api/profiles', { success: Schema.Array(Profile) }).annotateMerge(
      OpenApi.annotations({
        summary: 'List profiles',
        description: 'Returns all saved `llama-server` profiles sorted alphabetically by name (case-insensitive).',
      }),
    ),
    HttpApiEndpoint.post('create', '/api/profiles', {
      payload: ProfileInput,
      success: Created,
      error: ProfileNameTaken,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Create a profile',
        description:
          'Validates `ProfileInput` (rejecting reserved flags in `args`) and saves a new profile with source `ui`. Model paths are not verified on disk until launch.',
      }),
    ),
    HttpApiEndpoint.get('exportAll', '/api/profiles/export', { success: ProfilesFile }).annotateMerge(
      OpenApi.annotations({
        summary: 'Export all profiles',
        description:
          "Downloads all profiles as a portable JSON attachment (`Content-Disposition: attachment; filename*=UTF-8''llama-webui-profiles.json`).",
      }),
    ),
    // Any JSON: each item is validated on its own, so that one bad profile does not refuse the others.
    HttpApiEndpoint.post('importMany', '/api/profiles/import', {
      payload: Schema.Unknown,
      success: ImportResult,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Import profiles',
        description:
          'Imports a single `ProfileInput`, an array of profiles, or a `{ profiles: [...] }` export file. Each entry is validated independently so invalid or duplicate items are reported in `skipped` without rejecting valid ones.',
      }),
    ),
    HttpApiEndpoint.get('get', '/api/profiles/:id', { params, success: Profile, error: ProfileNotFound }).annotateMerge(
      OpenApi.annotations({
        summary: 'Get a profile',
        description: 'Returns one saved profile by numeric id.',
      }),
    ),
    HttpApiEndpoint.put('update', '/api/profiles/:id', {
      params,
      payload: ProfileInput,
      success: Profile,
      error: [ProfileNotFound, ProfileNameTaken],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Replace a profile',
        description:
          'Replaces all fields of an existing profile (omitted optional fields are cleared). A running server keeps its previous arguments until restarted.',
      }),
    ),
    HttpApiEndpoint.delete('remove', '/api/profiles/:id', {
      params,
      error: [ProfileNotFound, ProfileRunning],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Delete a profile',
        description:
          'Deletes a profile by id (`204 No Content`). Refused with `409 ProfileRunning` while it belongs to the running server.',
      }),
    ),
    HttpApiEndpoint.post('duplicate', '/api/profiles/:id/duplicate', {
      params,
      success: Created,
      error: ProfileNotFound,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Duplicate a profile',
        description:
          'Creates a copy of an existing profile with a unique name suffix (`(copy)`, `(copy 2)`…) and returns `201`.',
      }),
    ),
    HttpApiEndpoint.get('exportOne', '/api/profiles/:id/export', {
      params,
      success: ProfileExport,
      error: ProfileNotFound,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Export one profile',
        description: 'Downloads a single profile as a portable JSON attachment without id, source or timestamps.',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Profiles',
      description:
        'Saved `llama-server` launch configurations: CRUD, duplication, JSON import and attachment exports. `args` cannot include flags managed by llama-webui (`--host`, `--port`, `--metrics`, `--slots`, `--props`, `-m`, `--model`, `-mm`, `--mmproj`).',
    }),
  ) {}
