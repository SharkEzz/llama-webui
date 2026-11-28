import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from 'effect/http-api';
import { Settings } from '../settings.ts';
import { Issue } from './errors.ts';

/** A patch that does not validate: `Invalid settings`, and the message of each field it fails on. */
export class SettingsInvalid extends Schema.TaggedError<SettingsInvalid, { readonly SettingsInvalid: unique symbol }>()(
  'SettingsInvalid',
  {
    message: Schema.String,
    issues: Schema.Array(Issue),
  },
  { httpApiStatus: 400, description: 'SettingsInvalid: One or more merged setting values failed validation.' },
) {}

/** The settings after a patch, with a warning when the monitor could not apply them (saved all the same). */
export const SettingsPatched = Schema.Struct({
  ...Settings.fields,
  warning: Schema.optionalKey(Schema.String),
}).annotate({
  identifier: 'SettingsPatched',
  description:
    'Updated settings returned by PATCH /api/settings, with an optional warning if live monitor reconfiguration failed.',
});
export type SettingsPatched = typeof SettingsPatched.Type;

export class SettingsApi extends HttpApiGroup.make('settings')
  .add(
    HttpApiEndpoint.get('get', '/api/settings', { success: Settings }).annotateMerge(
      OpenApi.annotations({
        summary: 'Read settings',
        description: 'Returns the current persisted settings with defaults applied for any unset keys.',
      }),
    ),
    HttpApiEndpoint.patch('patch', '/api/settings', {
      // Any object: the repository validates the merge, for the message of each field.
      payload: Schema.Record(Schema.String, Schema.Unknown),
      success: SettingsPatched,
      error: SettingsInvalid,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Update settings',
        description:
          'Merges a partial settings patch into the stored configuration, validates the result, persists it to SQLite, and reconfigures the monitor (`collectors.nvml` requires a restart).',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Settings',
      description: 'Read and update persistent runtime settings stored in SQLite.',
    }),
  ) {}
