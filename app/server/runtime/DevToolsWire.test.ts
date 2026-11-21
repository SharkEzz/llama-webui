import { assert, it } from '@effect/vitest';
import { Effect, Metric, Schema, String as Str } from 'effect';
import { DevToolsSchema } from 'effect/devtools';
import { rewrite } from './DevToolsWire.ts';

const Wire = Schema.fromJsonString(Schema.toCodecJson(DevToolsSchema.Request));
const parse = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

it.effect('a metrics snapshot is sent in the shape of the VS Code extension', () =>
  Effect.gen(function* () {
    const counter = Metric.counter('c', { description: 'counted', incremental: true });
    yield* Metric.update(Metric.withAttributes(counter, { status: 'ok' }), 2);
    yield* Metric.update(Metric.frequency('f'), 'Defect');
    yield* Metric.update(Metric.gauge('g'), 3);
    yield* Metric.update(Metric.histogram('h', { boundaries: [1, 10, Number.POSITIVE_INFINITY] }), 5);
    const context = yield* Effect.context();
    const line = yield* Schema.encodeEffect(Wire)({
      _tag: 'MetricsSnapshot',
      metrics: Metric.snapshotUnsafe(context),
    });
    // Two NDJSON lines in one chunk, the second a ping that passes as it is.
    const chunk = yield* rewrite(`${line}\n{"_tag":"Ping"}\n`);
    const [snapshot, ping, end] = Str.split(chunk, '\n');
    assert.strictEqual(ping, '{"_tag":"Ping"}');
    assert.strictEqual(end, '');
    const legacy = yield* parse(snapshot);
    assert.deepStrictEqual(legacy, {
      _tag: 'MetricsSnapshot',
      metrics: [
        {
          _tag: 'Counter',
          name: 'c',
          description: 'counted',
          tags: [{ key: 'status', value: 'ok' }],
          state: { count: 2 },
        },
        { _tag: 'Frequency', name: 'f', tags: [], state: { occurrences: { Defect: 1 } } },
        { _tag: 'Gauge', name: 'g', tags: [], state: { value: 3 } },
        {
          _tag: 'Histogram',
          name: 'h',
          tags: [],
          state: {
            buckets: [
              [1, 0],
              [10, 1],
              [null, 1],
            ],
            count: 1,
            min: 5,
            max: 5,
            sum: 5,
          },
        },
      ],
    });
  }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
);

it.effect('a span event without attributes is sent with an empty record, a span as it is', () =>
  Effect.gen(function* () {
    const event = yield* Schema.encodeEffect(Wire)({
      _tag: 'SpanEvent',
      traceId: 't',
      spanId: 's',
      name: 'log',
      startTime: 1n,
      attributes: undefined,
    });
    const rewritten = yield* rewrite(event);
    const parsed = yield* parse(rewritten);
    assert.deepStrictEqual(parsed, {
      _tag: 'SpanEvent',
      traceId: 't',
      spanId: 's',
      name: 'log',
      startTime: '1',
      attributes: {},
    });
    const garbled = yield* rewrite('not json');
    assert.strictEqual(garbled, 'not json');
  }),
);
