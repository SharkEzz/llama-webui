import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { SetupReport } from '../setup.ts';

/** The first-run setup report. */
export class SetupApi extends HttpApiGroup.make('setup').add(
  HttpApiEndpoint.get('setup', '/api/setup', { success: SetupReport }),
) {}
