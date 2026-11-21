import { Array as Arr, Effect, Layer, Record as Rec, Schema, String as Str } from 'effect';
import { DevTools, DevToolsSchema } from 'effect/devtools';
import { Socket } from 'effect/socket';

/**
 * The Effect DevTools of the VS Code extension (`effectful-tech.effect-vscode`, 0.10.0) run a server that still decodes
 * the messages of Effect 3 (`@effect/experimental`'s DevTools): Effect 4's client sends its metrics in a shape it
 * refuses (`id`, `type`, `attributes`, a `Map` of occurrences, an `"Infinity"` bound), and a span event without
 * attributes (`null`). This socket rewrites those two messages, as the extension's own debugger instrumentation does;
 * the spans and the pings pass as they are. To remove once the extension decodes Effect 4's metrics.
 */

const Wire = Schema.fromJsonString(Schema.toCodecJson(DevToolsSchema.Request));
const decodeWire = Schema.decodeUnknownEffect(Wire);
const encodeWire = Schema.encodeEffect(Wire);

const Tag = Schema.Struct({ key: Schema.String, value: Schema.String });
const fields = {
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  tags: Schema.Array(Tag),
};
/** A number, or a bigint as its digits. */
const Amount = Schema.Union([Schema.Finite, Schema.String]);
const Distribution = { count: Schema.Finite, min: Schema.Finite, max: Schema.Finite, sum: Schema.Finite };
const Quantile = Schema.Union([Schema.TaggedStruct('None', {}), Schema.TaggedStruct('Some', { value: Schema.Finite })]);

/** A metric as Effect 3's DevTools decode it. */
const LegacyMetric = Schema.Union([
  Schema.TaggedStruct('Counter', { ...fields, state: Schema.Struct({ count: Amount }) }),
  Schema.TaggedStruct('Frequency', {
    ...fields,
    state: Schema.Struct({ occurrences: Schema.Record(Schema.String, Schema.Finite) }),
  }),
  Schema.TaggedStruct('Gauge', { ...fields, state: Schema.Struct({ value: Amount }) }),
  Schema.TaggedStruct('Histogram', {
    ...fields,
    // The last bound is `null` for infinity.
    state: Schema.Struct({
      buckets: Schema.Array(Schema.Tuple([Schema.NullOr(Schema.Finite), Schema.Finite])),
      ...Distribution,
    }),
  }),
  Schema.TaggedStruct('Summary', {
    ...fields,
    state: Schema.Struct({
      error: Schema.Finite,
      quantiles: Schema.Array(Schema.Tuple([Schema.Finite, Quantile])),
      ...Distribution,
    }),
  }),
]);
type LegacyMetric = typeof LegacyMetric.Type;

const encodeLegacy = Schema.encodeEffect(
  Schema.fromJsonString(Schema.TaggedStruct('MetricsSnapshot', { metrics: Schema.Array(LegacyMetric) })),
);

const amount = (value: number | bigint): number | string => (typeof value === 'bigint' ? `${value}` : value);

/** One metric of Effect 4's snapshot, in Effect 3's shape. */
export const toLegacy = (metric: DevToolsSchema.Metric): LegacyMetric => {
  const base = {
    name: metric.id,
    ...(metric.description === undefined ? {} : { description: metric.description }),
    tags: Arr.map(Rec.toEntries(metric.attributes ?? {}), ([key, value]) => ({ key, value })),
  };
  switch (metric.type) {
    case 'Counter':
      return { _tag: 'Counter', ...base, state: { count: amount(metric.state.count) } };
    case 'Frequency':
      return { _tag: 'Frequency', ...base, state: { occurrences: Rec.fromEntries(metric.state.occurrences) } };
    case 'Gauge':
      return { _tag: 'Gauge', ...base, state: { value: amount(metric.state.value) } };
    case 'Histogram': {
      const { buckets, ...rest } = metric.state;
      const bounded = Arr.map(buckets, ([bound, count]) => [Number.isFinite(bound) ? bound : null, count] as const);
      return { _tag: 'Histogram', ...base, state: { ...rest, buckets: bounded } };
    }
    case 'Summary': {
      const { quantiles, ...rest } = metric.state;
      const known = Arr.map(
        quantiles,
        ([quantile, value]) =>
          [quantile, value === undefined ? { _tag: 'None' as const } : { _tag: 'Some' as const, value }] as const,
      );
      return { _tag: 'Summary', ...base, state: { ...rest, error: 0, quantiles: known } };
    }
  }
};

/** One NDJSON line of the client, as the extension decodes it. A line that does not decode passes as it is. */
const rewriteLine = (line: string): Effect.Effect<string> =>
  decodeWire(line).pipe(
    Effect.flatMap((request) => {
      if (request._tag === 'MetricsSnapshot')
        return encodeLegacy({ _tag: 'MetricsSnapshot', metrics: Arr.map(request.metrics, toLegacy) });
      if (request._tag === 'SpanEvent' && request.attributes === undefined)
        return encodeWire({ ...request, attributes: {} });
      return Effect.succeed(line);
    }),
    Effect.orElseSucceed(() => line),
  );

/** A chunk the client writes: NDJSON lines. */
export const rewrite = (chunk: string): Effect.Effect<string> =>
  Effect.forEach(Str.split(chunk, '\n'), (line) => (line === '' ? Effect.succeed(line) : rewriteLine(line))).pipe(
    Effect.map(Arr.join('\n')),
  );

const rewriteChunk = (chunk: string | Uint8Array): Effect.Effect<string | Uint8Array> =>
  typeof chunk === 'string' ? rewrite(chunk) : Effect.succeed(chunk);

const legacySocket = (socket: Socket.Socket): Socket.Socket =>
  Socket.make({
    reader: socket.reader,
    writer: Effect.map(socket.writer, (writer) => ({
      write: (chunk) =>
        typeof chunk === 'string' ? Effect.flatMap(rewrite(chunk), writer.write) : writer.write(chunk),
      writeAll: (chunks) =>
        Effect.forEach(chunks, rewriteChunk).pipe(
          Effect.flatMap((rewritten) =>
            Arr.isReadonlyArrayNonEmpty(rewritten) ? writer.writeAll(rewritten) : Effect.void,
          ),
        ),
    })),
  });

/** `DevTools.layer(url)`, its messages rewritten for the VS Code extension. */
export const layer = (url: string): Layer.Layer<never> =>
  DevTools.layerSocket.pipe(
    Layer.provide(Layer.effect(Socket.Socket, Effect.map(Socket.Socket, legacySocket))),
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
