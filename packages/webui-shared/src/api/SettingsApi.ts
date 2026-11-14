import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { Settings } from '../settings.ts';
import { Issue } from './errors.ts';

/** A patch that does not validate: `Invalid settings`, and the message of each field it fails on. */
export class SettingsInvalid extends Schema.TaggedError<SettingsInvalid, { readonly SettingsInvalid: unique symbol }>()(
  'SettingsInvalid',
  {
    message: Schema.String,
    issues: Schema.Array(Issue),
  },
  { httpApiStatus: 400 },
) {}

export class SettingsApi extends HttpApiGroup.make('settings').add(
  HttpApiEndpoint.get('get', '/api/settings', { success: Settings }),
  HttpApiEndpoint.patch('patch', '/api/settings', {
    // Any object: the repository validates the merge, for the message of each field.
    payload: Schema.Record(Schema.String, Schema.Unknown),
    success: Settings,
    error: SettingsInvalid,
  }),
) {}
