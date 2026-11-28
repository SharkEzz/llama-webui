import { Api } from '@llama-webui/shared';
import { Array as Arr, Effect, Layer, String as Str } from 'effect';
import { HttpMiddleware, HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
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

/**
 * The docs page is about 5 MB of HTML (Scalar's bundle inlined): it goes out in gzip (about a quarter of it) to a
 * client that accepts it. The server-wide compression only takes JSON.
 */
const compressHtml = HttpMiddleware.compression({
  algorithms: ['gzip'],
  compressible: Str.startsWith('text/html'),
  minSize: 1024,
});

/** A weak validator of the page's bytes (their length and FNV-1a hash): the same page has the same tag across restarts. */
const etagOf = (bytes: Uint8Array): string => {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return `W/"${bytes.length.toString(16)}-${(hash >>> 0).toString(16)}"`;
};

/** Whether `If-None-Match` names `etag`, by the weak comparison a `GET` uses (`*` matches any). */
const matchesEtag = (header: string | undefined, etag: string): boolean => {
  if (header === undefined) return false;
  const opaque = (tag: string) => Str.replace(/^W\//, '')(Str.trim(tag));
  return Arr.some(Str.split(header, ','), (tag) => Str.trim(tag) === '*' || opaque(tag) === opaque(etag));
};

/**
 * Around Effect's Scalar page: compressed (`compressHtml`), with an ETag and `no-cache`, so a browser revalidates it
 * and gets a 304 instead of the 5 MB again while the page has not changed.
 */
const Revalidated = HttpRouter.middleware(
  Effect.gen(function* () {
    const platform = yield* HttpPlatform.HttpPlatform;
    // Effect builds the page once: its tag is computed on the first request, then kept.
    let etag: string | undefined;
    const headers = (tag: string) => ({ etag: tag, 'cache-control': 'no-cache' });
    return (page) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (etag !== undefined && matchesEtag(request.headers['if-none-match'], etag)) {
          return HttpServerResponse.empty({ status: 304, headers: headers(etag) });
        }
        const response = yield* page;
        if (response.body._tag !== 'Uint8Array') return response;
        etag ??= etagOf(response.body.body);
        return HttpServerResponse.setHeaders(response, headers(etag));
      }).pipe(compressHtml, Effect.provideService(HttpPlatform.HttpPlatform, platform));
  }),
).layer;

const ScalarRoute = Layer.unwrap(
  Effect.gen(function* () {
    const { version } = yield* AppInfo;
    return HttpApiScalar.layer(annotatedApi({ version }), { path: '/api/docs', scalar: SCALAR_CONFIG });
  }),
).pipe(Layer.provide(Revalidated));

/**
 * Serves the OpenAPI 3.1 specification at `GET /api/openapi.json` and the offline Scalar API reference UI at
 * `GET /api/docs`. Mounted inside `ApiRoutes` behind `Guarded`.
 */
export const OpenApiDocsLive: Layer.Layer<never, never, HttpRouter.HttpRouter | HttpPlatform.HttpPlatform | AppInfo> =
  Layer.merge(OpenApiJsonRoute, ScalarRoute);
