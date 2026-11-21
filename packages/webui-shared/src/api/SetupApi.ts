import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { LaunchpadEntry, SetupReport } from '../setup.ts';

/** The first run: the setup report, and the launch pad of the Home page (one card per profile). */
export class SetupApi extends HttpApiGroup.make('setup').add(
  HttpApiEndpoint.get('setup', '/api/setup', { success: SetupReport }),
  HttpApiEndpoint.get('launchpad', '/api/launchpad', { success: Schema.Array(LaunchpadEntry) }),
) {}
