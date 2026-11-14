import { PropsUnavailable } from '@llama-webui/shared';
import { Effect, Option, Schema } from 'effect';
import { probeUrl } from 'llamacpp-js/client';
import { LlamaHttp } from './LlamaHttp.ts';

/** How long a probe of `/health` waits for its answer. */
const PROBE_TIMEOUT = '800 millis';
/** How long `/props` may take. */
const PROPS_TIMEOUT = '2 seconds';

/** Where a llama-server listens: `host` absent, empty or a wildcard means loopback. */
export interface Target {
  readonly host?: string | null;
  readonly port: number;
}

const healthUrl = (target: Target) => `${probeUrl(target.host, target.port)}/health`;

/** The status `/health` answers (200 once loaded, 503 while loading), none when nothing answers within 800 ms. */
export const health = Effect.fn('probes.health')(function* (target: Target) {
  const client = yield* LlamaHttp;
  return yield* client.get(healthUrl(target)).pipe(
    Effect.map((res) => res.status),
    Effect.scoped,
    Effect.timeoutOption(PROBE_TIMEOUT),
    Effect.orElseSucceed(Option.none<number>),
  );
});

/**
 * Whether the service there is a llama-server: its `/health` answers JSON, `{"status":"ok"}` once loaded or
 * `{"error":{"type":"unavailable_error",…}}` while loading, within 800 ms. Any other HTTP service (a web server,
 * another API) is not one (#28).
 */
export const isLlamaServer = Effect.fn('probes.isLlamaServer')(function* (target: Target) {
  const client = yield* LlamaHttp;
  const body = yield* client.get(healthUrl(target)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.scoped,
    Effect.timeoutOption(PROBE_TIMEOUT),
    Effect.orElseSucceed(Option.none<unknown>),
  );
  return Option.exists(body, isHealthBody);
});

/** What llama-server's `/health` answers: its status, or the error of a model still loading. */
const isHealthBody = Schema.is(
  Schema.Union([
    Schema.Struct({ status: Schema.String }),
    Schema.Struct({ error: Schema.Struct({ type: Schema.Literal('unavailable_error') }) }),
  ]),
);

const unavailable = (message: string) => PropsUnavailable.make({ message });

/**
 * llama-server's `/props` at `baseUrl`, its JSON as it is, within 2 s. An error status, a body that is not JSON and no
 * answer are each a `PropsUnavailable` with its own message (#37).
 */
export const props = Effect.fn('probes.props')(function* (baseUrl: string) {
  const client = yield* LlamaHttp;
  return yield* client.get(`${baseUrl}/props`).pipe(
    Effect.mapError(() => unavailable('llama-server is not responding on /props')),
    Effect.flatMap((res) =>
      res.status < 200 || res.status >= 300
        ? Effect.fail(unavailable(`llama-server /props: HTTP ${res.status}`))
        : res.json.pipe(Effect.mapError(() => unavailable('llama-server /props: the reply is not JSON'))),
    ),
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: PROPS_TIMEOUT,
      orElse: () => Effect.fail(unavailable('llama-server is not responding on /props')),
    }),
  );
});
