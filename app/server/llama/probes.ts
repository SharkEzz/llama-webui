import { PropsUnavailable } from '@llama-webui/shared';
import { Clock, Effect, Option, Schema } from 'effect';
import type { HttpClientResponse } from 'effect/http';
import { probeUrl } from 'llamacpp-js/client';
import { type Health, type LlamaRaw, parsePrometheus, parseSlots } from 'llamacpp-js/metrics';
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

const urlOf = (target: Target, path: string) => `${probeUrl(target.host, target.port)}${path}`;
const healthUrl = (target: Target) => urlOf(target, '/health');

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

const healthOf = (status: number): Health => (status === 200 ? 'ok' : status === 503 ? 'loading' : 'error');

/**
 * One monitoring read of llama-server: `/health` (200 `ok`, 503 `loading`, another status `error`, nothing within
 * 800 ms `down`), then, once it is `ok`, `/slots` and `/metrics` together, each within 800 ms, null on any failure.
 * `at` is the time of the read.
 */
export const readLlama = Effect.fn('probes.readLlama')(function* (target: Target) {
  const client = yield* LlamaHttp;
  const at = yield* Clock.currentTimeMillis;
  const status = yield* health(target);
  if (Option.isNone(status)) return { at, health: 'down', slots: null, metrics: null } satisfies LlamaRaw;
  const state = healthOf(status.value);
  if (state !== 'ok') return { at, health: state, slots: null, metrics: null } satisfies LlamaRaw;
  const read = <A>(path: string, body: (res: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, unknown>) =>
    client.get(urlOf(target, path)).pipe(
      Effect.flatMap(body),
      Effect.scoped,
      Effect.timeoutOption(PROBE_TIMEOUT),
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
  const [slots, metrics] = yield* Effect.all(
    [
      read('/slots', (res) => Effect.map(res.json, parseSlots)),
      read('/metrics', (res) => Effect.map(res.text, parsePrometheus)),
    ],
    { concurrency: 2 },
  );
  return { at, health: state, slots, metrics } satisfies LlamaRaw;
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
