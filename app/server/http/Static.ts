import { Array as Arr, Effect, Layer, Option, Order, Path, String as Str } from 'effect';
import { HttpRouter, type HttpServerError, HttpServerRequest, HttpServerResponse, HttpStaticServer } from 'effect/http';
import { AppConfig } from '../config/AppConfig.ts';

/** The cache of a hashed asset, as the Nitro server sent it: its name changes with its content. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** A page or a file of the root: revalidated on every load, a new build's `index.html` names new assets. */
const REVALIDATE = 'no-cache';

/**
 * The types of the assets the build precompresses (`COMPRESSIBLE` of `app/build/precompress.ts`), by extension: those
 * of the static server, given to it so that a file and its variants are sent with the same type.
 */
export const ENCODED_TYPES: Readonly<Record<string, string>> = {
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
  json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  wasm: 'application/wasm',
};

/** The variants the build writes next to an asset, in the server's order of preference. */
const ENCODINGS = [
  { name: 'br', suffix: '.br' },
  { name: 'gzip', suffix: '.gz' },
] as const;

type Encoding = (typeof ENCODINGS)[number];

/**
 * The encodings of `ENCODINGS` that an `Accept-Encoding` header accepts, the highest `q` first, a tie in the server's
 * order. A coding it does not name takes the `q` of `*`, else is refused; `q=0` refuses. No header: none, the file is
 * sent as it is.
 */
export const acceptedEncodings = (header: string | undefined): ReadonlyArray<Encoding> => {
  if (header === undefined) return [];
  const weights = new Map<string, number>();
  for (const member of Str.split(header, ',')) {
    const [coding, ...params] = Arr.map(Str.split(member, ';'), (part) => Str.toLowerCase(Str.trim(part)));
    if (coding === '') continue;
    const weight = Option.match(Arr.findFirst(params, Str.startsWith('q=')), {
      onNone: () => 1,
      onSome: (q) => Number(Str.slice(2)(q)),
    });
    weights.set(coding, Number.isFinite(weight) ? weight : 0);
  }
  const weightOf = (encoding: Encoding) => weights.get(encoding.name) ?? weights.get('*') ?? 0;
  const heaviestFirst = Order.flip(Order.mapInput(Order.Number, weightOf));
  return Arr.sort(
    Arr.filter(ENCODINGS, (encoding) => weightOf(encoding) > 0),
    heaviestFirst,
  );
};

/**
 * A hashed asset: its Brotli or gzip variant written by the build (`<file>.br`, `<file>.gz`) when the client accepts
 * one, sent with the file's type and its `Content-Encoding`, else the file. A request for a range is sent the file: a
 * range counts the bytes of the file. A type the build compresses varies with `Accept-Encoding`.
 */
const negotiated = Effect.fnUntraced(function* (
  assets: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError.HttpServerError,
    HttpServerRequest.HttpServerRequest
  >,
  path: Path.Path,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const [pathname, query] = Option.match(Str.indexOf('?')(request.url), {
    onNone: () => [request.url, ''],
    onSome: (at) => [Str.slice(0, at)(request.url), Str.slice(at)(request.url)],
  });
  const type = ENCODED_TYPES[Str.slice(1)(path.extname(pathname))];
  if (type === undefined) return yield* assets;
  const vary = HttpServerResponse.setHeader('vary', 'Accept-Encoding');
  const encodings = request.headers.range === undefined ? acceptedEncodings(request.headers['accept-encoding']) : [];
  for (const encoding of encodings) {
    const variant = yield* assets.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        request.modify({ url: `${pathname}${encoding.suffix}${query}` }),
      ),
      Effect.asSome,
      Effect.catchReason('HttpServerError', 'RouteNotFound', () => Effect.succeedNone),
    );
    if (Option.isSome(variant))
      return variant.value.pipe(
        HttpServerResponse.setHeaders({ 'content-type': type, 'content-encoding': encoding.name }),
        HttpServerResponse.removeHeader('accept-ranges'),
        vary,
      );
  }
  return yield* Effect.map(assets, vary);
});

/**
 * The UI of `root`. `/assets/*` is a hashed asset of `root/assets`, immutable, precompressed for the clients that
 * accept it (`negotiated`), and a missing one is a 404 (a stale tab after an upgrade asks for the old names). Any other GET no other route takes is a file of `root` when there is one,
 * `index.html` otherwise (the client's router reads the path), both revalidated. The HTML fallback does not depend on
 * the `Accept` header.
 */
export const layerFrom = (root: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const path = yield* Path.Path;
      const assets = yield* HttpStaticServer.make({
        root,
        index: undefined,
        cacheControl: IMMUTABLE,
        mimeTypes: ENCODED_TYPES,
      });
      const files = yield* HttpStaticServer.make({ root, cacheControl: REVALIDATE });
      const index = HttpServerResponse.file(path.join(root, 'index.html'), {
        contentType: 'text/html; charset=utf-8',
      }).pipe(Effect.map(HttpServerResponse.setHeader('cache-control', REVALIDATE)), Effect.orDie);
      yield* router.add('GET', '/assets/*', negotiated(assets, path));
      yield* router.add('GET', '/*', files.pipe(Effect.catchReason('HttpServerError', 'RouteNotFound', () => index)));
    }),
  );

/** The UI built next to the server bundle (`<bundle folder>/../public`); nothing in dev, where Vite serves it. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { dev } = yield* AppConfig;
    const path = yield* Path.Path;
    return dev ? Layer.empty : layerFrom(path.join(import.meta.dirname, '..', 'public'));
  }),
);
