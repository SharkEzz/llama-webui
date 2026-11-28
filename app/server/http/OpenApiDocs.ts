import { Api } from '@llama-webui/shared';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { HttpApiScalar, OpenApi } from 'effect/http-api';
import { AppInfo } from '../config/AppInfo.ts';

/** Offline-safe Scalar configuration shared by the server (`/api/docs`) and the static docs site. */
export const SCALAR_CONFIG = {
  agent: { disabled: true },
  withDefaultFonts: false,
} as const satisfies HttpApiScalar.ScalarConfig;

export interface OpenApiOptions {
  readonly version: string;
  readonly servers?: ReadonlyArray<OpenApi.OpenAPISpecServer>;
}

/** `Api` annotated with the running (or published) version and optional server list. */
export const annotatedApi = (options: OpenApiOptions) =>
  Api.annotateMerge(
    OpenApi.annotations({
      version: options.version,
      ...(options.servers === undefined ? {} : { servers: options.servers }),
    }),
  );

/** OpenAPI 3.1 document generated from `Api` with the given version and optional server list. */
export const openApiSpec = (options: OpenApiOptions) => OpenApi.fromApi(annotatedApi(options));

const OpenApiJsonRoute = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const { version } = yield* AppInfo;
    const response = yield* HttpServerResponse.json(openApiSpec({ version })).pipe(Effect.orDie);
    yield* router.add('GET', '/api/openapi.json', Effect.succeed(response));
  }),
);

const ScalarRoute = Layer.unwrap(
  Effect.gen(function* () {
    const { version } = yield* AppInfo;
    return HttpApiScalar.layer(annotatedApi({ version }), {
      path: '/api/docs',
      scalar: SCALAR_CONFIG,
    });
  }),
);

/**
 * Serves the OpenAPI 3.1 specification at `GET /api/openapi.json` and the offline Scalar API reference UI at
 * `GET /api/docs`. Mounted inside `ApiRoutes` behind `Guarded`.
 */
export const OpenApiDocsLive: Layer.Layer<never, never, HttpRouter.HttpRouter | AppInfo> = Layer.merge(
  OpenApiJsonRoute,
  ScalarRoute,
);
