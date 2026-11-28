import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from 'effect/http-api';

/** The reply of `GET /api/health`: the server is up, which build it runs, since when, and which start this is. */
export const Health = Schema.Struct({
  ok: Schema.Literal(true),
  version: Schema.String.annotate({
    description: 'Build version (git tag/describe in production, "dev" from source).',
  }),
  uptimeMs: Schema.Int.annotate({ description: 'Milliseconds elapsed since llama-webui started.' }),
  bootId: Schema.String.annotate({ description: 'Random UUID generated on startup; changes across restarts.' }),
}).annotate({
  identifier: 'Health',
  description: 'Liveness status, build version, uptime and process boot identifier.',
});

export class HealthApi extends HttpApiGroup.make('health')
  .add(
    HttpApiEndpoint.get('get', '/api/health', { success: Health }).annotateMerge(
      OpenApi.annotations({
        summary: 'Check server health',
        description: 'Returns liveness status, build version, uptime in milliseconds, and the process `bootId`.',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Health',
      description: 'Liveness and process identity of the llama-webui server.',
    }),
  ) {}
