import { Clock, Context, Effect, Layer } from 'effect';
import { SecureRandom } from 'effect/crypto';

/** Replaced by the build (`build/server.ts`) with the version it built; absent when the server runs from source. */
declare const LLAMA_WEBUI_VERSION: string | undefined;

/** `dev` from source; at build, `git describe --tags --always --dirty`, else the version of package.json. */
export const VERSION = typeof LLAMA_WEBUI_VERSION === 'string' ? LLAMA_WEBUI_VERSION : 'dev';

/** What this process is: read by `/api/health` and the hello of `/ws`. */
export class AppInfo extends Context.Service<
  AppInfo,
  {
    /** `dev` from source; at build, `git describe --tags --always --dirty`, else the version of package.json. */
    readonly version: string;
    /** A fresh opaque id per process start: the web sees a restart by its change. */
    readonly bootId: string;
    /** Milliseconds since the start. */
    readonly uptimeMs: Effect.Effect<number>;
  }
>()('@llama-webui/app/server/config/AppInfo') {
  static readonly layer: Layer.Layer<AppInfo> = Layer.effect(
    AppInfo,
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const bootId = yield* SecureRandom.SecureRandom.use((random) => random.uuidV4());
      return {
        version: VERSION,
        bootId,
        uptimeMs: Effect.map(Clock.currentTimeMillis, (now) => now - startedAt),
      };
    }),
  ).pipe(Layer.provide(SecureRandom.layerWebCrypto));
}
