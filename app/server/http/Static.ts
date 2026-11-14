import { Effect, Layer, Path } from 'effect';
import { HttpRouter, HttpServerResponse, HttpStaticServer } from 'effect/http';
import { AppConfig } from '../config/AppConfig.ts';

/**
 * The UI of `root` on every GET no other route takes: a file of `root` when there is one, `index.html` otherwise (the
 * client's router reads the path). The HTML fallback does not depend on the `Accept` header.
 */
export const layerFrom = (root: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const path = yield* Path.Path;
      const files = yield* HttpStaticServer.make({ root });
      const index = HttpServerResponse.file(path.join(root, 'index.html'), {
        contentType: 'text/html; charset=utf-8',
      }).pipe(Effect.orDie);
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
