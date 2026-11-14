import { Effect, Layer, Path } from 'effect';
import { HttpRouter, HttpServerResponse, HttpStaticServer } from 'effect/http';
import { AppConfig } from '../config/AppConfig.ts';

/** The cache of a hashed asset, as the Nitro server sent it: its name changes with its content. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** A page or a file of the root: revalidated on every load, a new build's `index.html` names new assets. */
const REVALIDATE = 'no-cache';

/**
 * The UI of `root`. `/assets/*` is a hashed asset of `root/assets`, immutable, and a missing one is a 404 (a stale tab
 * after an upgrade asks for the old names). Any other GET no other route takes is a file of `root` when there is one,
 * `index.html` otherwise (the client's router reads the path), both revalidated. The HTML fallback does not depend on
 * the `Accept` header.
 */
export const layerFrom = (root: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const path = yield* Path.Path;
      const assets = yield* HttpStaticServer.make({ root, index: undefined, cacheControl: IMMUTABLE });
      const files = yield* HttpStaticServer.make({ root, cacheControl: REVALIDATE });
      const index = HttpServerResponse.file(path.join(root, 'index.html'), {
        contentType: 'text/html; charset=utf-8',
      }).pipe(Effect.map(HttpServerResponse.setHeader('cache-control', REVALIDATE)), Effect.orDie);
      yield* router.add('GET', '/assets/*', assets);
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
