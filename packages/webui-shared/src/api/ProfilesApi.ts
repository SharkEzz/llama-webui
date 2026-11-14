import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api';
import { Profile, ProfileInput } from '../profile.ts';
import { IdParam } from './params.ts';

/** No profile has this id: `Profile not found`. */
export class ProfileNotFound extends Schema.TaggedError<ProfileNotFound, { readonly ProfileNotFound: unique symbol }>()(
  'ProfileNotFound',
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** Another profile has this name: `A profile named “<name>” already exists`. */
export class ProfileNameTaken extends Schema.TaggedError<
  ProfileNameTaken,
  { readonly ProfileNameTaken: unique symbol }
>()('ProfileNameTaken', { message: Schema.String }, { httpApiStatus: 409 }) {}

/** The file of every profile, in the import format (`llama-webui-profiles.json`). */
export const ProfilesFile = Schema.Struct({ profiles: Schema.Array(ProfileInput) });

/** What an import created, and each profile it skipped with the reason. */
export const ImportResult = Schema.Struct({
  imported: Schema.Array(Profile),
  skipped: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
});

const Created = Profile.pipe(HttpApiSchema.status(201));
const params = { id: IdParam };

/** The launch profiles: their list, each one by id, the exports and the imports. */
export class ProfilesApi extends HttpApiGroup.make('profiles').add(
  HttpApiEndpoint.get('list', '/api/profiles', { success: Schema.Array(Profile) }),
  HttpApiEndpoint.post('create', '/api/profiles', {
    payload: ProfileInput,
    success: Created,
    error: ProfileNameTaken,
  }),
  HttpApiEndpoint.get('exportAll', '/api/profiles/export', { success: ProfilesFile }),
  // Any JSON: each item is validated on its own, so that one bad profile does not refuse the others.
  HttpApiEndpoint.post('importMany', '/api/profiles/import', { payload: Schema.Unknown, success: ImportResult }),
  HttpApiEndpoint.get('get', '/api/profiles/:id', { params, success: Profile, error: ProfileNotFound }),
  HttpApiEndpoint.put('update', '/api/profiles/:id', {
    params,
    payload: ProfileInput,
    success: Profile,
    error: [ProfileNotFound, ProfileNameTaken],
  }),
  HttpApiEndpoint.delete('remove', '/api/profiles/:id', { params, error: ProfileNotFound }),
  HttpApiEndpoint.post('duplicate', '/api/profiles/:id/duplicate', {
    params,
    success: Created,
    error: ProfileNotFound,
  }),
  HttpApiEndpoint.get('exportOne', '/api/profiles/:id/export', {
    params,
    success: ProfileInput,
    error: ProfileNotFound,
  }),
) {}
