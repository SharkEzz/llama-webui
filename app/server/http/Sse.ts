import { Array as Arr, type Duration, Effect, String as Str, Stream } from 'effect';
import { dual } from 'effect/Function';
import { HttpServerResponse } from 'effect/http';

/** One message of the stream: an optional `event:` name and its data, any number of lines. */
export interface SseEvent {
  readonly event?: string;
  readonly data: string;
}

/** As h3's `createEventStream` wrote it: a single-line `event:`, one `data:` per line, a blank line. */
const format = ({ event, data }: SseEvent): string => {
  const name = event === undefined || event === '' ? '' : `event: ${Str.replace(/[\r\n]/g, '')(event)}\n`;
  const lines = Arr.join(
    Arr.map(Str.split(data, /\r\n|\r|\n/), (line) => `data: ${line}\n`),
    '',
  );
  return `${name}${lines}\n`;
};

/**
 * The headers of the Nitro server's stream: not cached nor buffered by a proxy, and not kept alive once it ends (at
 * shutdown a browser keeps an idle connection open well past the grace delay of the server).
 */
const HEADERS = {
  'cache-control': 'private, no-cache, no-store, no-transform, must-revalidate, max-age=0',
  'x-accel-buffering': 'no',
  connection: 'close',
};

export interface SseOptions {
  /** The silence after which a `: ping` comment is sent, 15 s by default. */
  readonly pingInterval?: Duration.Input;
}

/**
 * A `text/event-stream` response fed by `events`: a `: ping` comment every `pingInterval` (15 s by default), so that
 * a long silence (a prompt being processed) is not taken for a dead connection by a proxy, the headers of the Nitro
 * server's stream, ended when `events` ends. A client that goes away interrupts `events`. A failure of `events` is
 * logged and ends the response.
 */
export const sseResponse: {
  (
    options?: SseOptions,
  ): <E, R>(events: Stream.Stream<SseEvent, E, R>) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>;
  <E, R>(
    events: Stream.Stream<SseEvent, E, R>,
    options?: SseOptions,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>;
} = dual(
  // Data first when the stream comes first; data last starts with the options, or nothing.
  (args) => Stream.isStream(args[0]),
  <E, R>(
    events: Stream.Stream<SseEvent, E, R>,
    options?: SseOptions,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> => {
    const pings = Stream.tick(options?.pingInterval ?? '15 seconds').pipe(
      // The first tick comes at once: a ping is due after a silence only.
      Stream.drop(1),
      Stream.as(': ping\n\n'),
    );
    const body = events.pipe(
      Stream.map(format),
      Stream.catchCause((cause) => Stream.fromEffectDrain(Effect.logError('an event stream failed', cause))),
      Stream.merge(pings, { haltStrategy: 'left' }),
      Stream.encodeText,
      // An empty first chunk: Node sends the headers with the first write, and the client should not wait for the
      // first event (a long prompt) to know the stream is open.
      Stream.prepend([new Uint8Array(0)]),
    );
    return Effect.map(Effect.context<R>(), (context) =>
      HttpServerResponse.stream(Stream.provideContext(body, context), {
        contentType: 'text/event-stream',
        headers: HEADERS,
      }),
    );
  },
);
