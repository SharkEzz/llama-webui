import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

/** The reply of `GET /api/health`: the server is up, which build it runs, since when, and which start this is. */
export const Health = Schema.Struct({
  ok: Schema.Literal(true),
  version: Schema.String,
  uptimeMs: Schema.Int,
  bootId: Schema.String,
});

export class HealthApi extends HttpApiGroup.make('health').add(
  HttpApiEndpoint.get('get', '/api/health', { success: Health }),
) {}
