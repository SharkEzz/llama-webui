import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { assert, describe, it } from '@effect/vitest';
import {
  Array as Arr,
  Clock,
  ConfigProvider,
  Duration,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  Schema,
  Scope,
  Tracer,
} from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { OtlpExporter } from 'effect/observability';
import { VERSION } from '../config/AppInfo.ts';
import { httpStub } from '../testing/llama.ts';
import { HttpMetrics } from './Metrics.ts';
import * as Otlp from './Otlp.ts';

const readPlan = (env: Record<string, string>) =>
  Otlp.readOtlpConfig.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })));

interface Captured {
  readonly url: string;
  readonly contentType: string | undefined;
  readonly authorization: string | undefined;
  readonly body: Uint8Array;
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const runWithLayer =
  <A, E, R, S, LE>(env: Record<string, string>, otlpLayer: Layer.Layer<S, LE>) =>
  (effect: Effect.Effect<A, E, R | S>) =>
    Layer.build(otlpLayer).pipe(
      Effect.flatMap((ctx) => Effect.provideContext(effect, ctx)),
      Effect.scoped,
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    );

const captureServer = Effect.gen(function* () {
  const received: Array<Captured> = [];
  const stub = yield* httpStub((req, res) => {
    const chunks: Array<Uint8Array> = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(new Uint8Array(chunk));
    });
    req.on('end', () => {
      const total = Arr.reduce(chunks, 0, (n, c) => n + c.byteLength);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      received.push({
        url: req.url ?? '',
        contentType: req.headers['content-type'],
        authorization: req.headers.authorization,
        body: merged,
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  return { stub, received };
});

describe('Otlp.readOtlpConfig', () => {
  it.effect('disables both signals when no endpoint is set', () =>
    Effect.gen(function* () {
      const plan = yield* readPlan({});
      assert.isTrue(Option.isNone(plan.traces));
      assert.isTrue(Option.isNone(plan.metrics));
    }),
  );

  it.effect('enables traces and metrics with standard defaults from OTEL_EXPORTER_OTLP_ENDPOINT', () =>
    Effect.gen(function* () {
      const plan = yield* readPlan({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/collector/' });
      const traces = Option.getOrThrow(plan.traces);
      const metrics = Option.getOrThrow(plan.metrics);
      assert.strictEqual(traces.url, 'http://127.0.0.1:4318/collector/v1/traces');
      assert.strictEqual(metrics.url, 'http://127.0.0.1:4318/collector/v1/metrics');
      assert.strictEqual(traces.protocol, 'http/protobuf');
      assert.strictEqual(metrics.protocol, 'http/protobuf');
      assert.strictEqual(traces.resource.serviceName, 'llama-webui');
      assert.strictEqual(traces.resource.serviceVersion, VERSION);
      assert.strictEqual(Duration.toMillis(traces.shutdownTimeout), 1000);
      assert.strictEqual(Duration.toMillis(metrics.shutdownTimeout), 1000);
      assert.strictEqual(traces.compression, 'none');
      assert.strictEqual(metrics.temporality, 'cumulative');
    }),
  );

  it.effect('honours OTEL_SDK_DISABLED=true and per-signal OTEL_*_EXPORTER=none', () =>
    Effect.gen(function* () {
      const disabled = yield* readPlan({
        OTEL_SDK_DISABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      });
      assert.isTrue(Option.isNone(disabled.traces));
      assert.isTrue(Option.isNone(disabled.metrics));

      const tracesOnly = yield* readPlan({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        OTEL_METRICS_EXPORTER: 'none',
      });
      assert.isTrue(Option.isSome(tracesOnly.traces));
      assert.isTrue(Option.isNone(tracesOnly.metrics));

      const metricsOnly = yield* readPlan({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        OTEL_TRACES_EXPORTER: 'none',
      });
      assert.isTrue(Option.isNone(metricsOnly.traces));
      assert.isTrue(Option.isSome(metricsOnly.metrics));
    }),
  );

  it.effect(
    'supports signal-specific endpoints, protocols, headers, resource attributes, compression and timeouts',
    () =>
      Effect.gen(function* () {
        const plan = yield* readPlan({
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://traces.local:4318/custom/traces',
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://metrics.local:4318/custom/metrics',
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
          OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/protobuf',
          OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20base',
          OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'authorization=Bearer%20traces',
          OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
          OTEL_EXPORTER_OTLP_TIMEOUT: '750',
          OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: '600',
          OTEL_BSP_SCHEDULE_DELAY: '2500',
          OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '256',
          OTEL_BSP_MAX_QUEUE_SIZE: '512',
          OTEL_METRIC_EXPORT_INTERVAL: '15000',
          OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
          OTEL_SERVICE_NAME: 'my-llama',
          OTEL_SERVICE_VERSION: '9.9.9',
        });
        const traces = Option.getOrThrow(plan.traces);
        const metrics = Option.getOrThrow(plan.metrics);
        assert.strictEqual(traces.url, 'http://traces.local:4318/custom/traces');
        assert.strictEqual(metrics.url, 'http://metrics.local:4318/custom/metrics');
        assert.strictEqual(traces.protocol, 'http/json');
        assert.strictEqual(metrics.protocol, 'http/protobuf');
        assert.deepStrictEqual(traces.headers, { authorization: 'Bearer traces' });
        assert.deepStrictEqual(metrics.headers, { authorization: 'Bearer base' });
        assert.strictEqual(traces.compression, 'gzip');
        assert.strictEqual(metrics.compression, 'gzip');
        assert.strictEqual(Duration.toMillis(traces.shutdownTimeout), 750);
        assert.strictEqual(Duration.toMillis(metrics.shutdownTimeout), 600);
        assert.strictEqual(Duration.toMillis(traces.exportInterval), 2500);
        assert.strictEqual(traces.maxBatchSize, 256);
        assert.strictEqual(traces.maxQueueSize, 512);
        assert.strictEqual(Duration.toMillis(metrics.exportInterval), 15_000);
        assert.strictEqual(metrics.temporality, 'delta');
        assert.strictEqual(traces.resource.serviceName, 'my-llama');
        assert.strictEqual(traces.resource.serviceVersion, '9.9.9');
      }),
  );

  it.effect('uses service.name and service.version from OTEL_RESOURCE_ATTRIBUTES when OTEL_SERVICE_* are unset', () =>
    Effect.gen(function* () {
      const plan = yield* readPlan({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        OTEL_RESOURCE_ATTRIBUTES: 'service.name=from-attrs,service.version=1.2.3,deployment.environment=prod',
      });
      const traces = Option.getOrThrow(plan.traces);
      assert.strictEqual(traces.resource.serviceName, 'from-attrs');
      assert.strictEqual(traces.resource.serviceVersion, '1.2.3');
    }),
  );

  it.effect('fails with ConfigError on unsupported protocol or exporter or malformed URL', () =>
    Effect.gen(function* () {
      for (const [label, env] of [
        [
          'grpc protocol',
          { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
        ],
        ['unknown exporter', { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_TRACES_EXPORTER: 'jaeger' }],
        ['malformed url', { OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' }],
      ] as const) {
        const exit = yield* Effect.exit(readPlan(env));
        assert.isTrue(Exit.isFailure(exit), label);
      }
    }),
  );
});

describe('Otlp export', () => {
  it.live('exports spans and metrics as OTLP/JSON with headers and resource metadata on flush', () =>
    Effect.gen(function* () {
      const { stub, received } = yield* captureServer;
      const env = {
        OTEL_EXPORTER_OTLP_ENDPOINT: stub.url,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20tok',
        OTEL_SERVICE_NAME: 'llama-test',
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=ci',
      };
      const testLayer = Otlp.layerWithClient(NodeHttpClient.layerNodeHttpOptions({ keepAlive: false }));
      const work = Effect.gen(function* () {
        yield* Metric.update(Metric.withAttributes(HttpMetrics.requests, { method: 'GET', class: '2xx' }), 1);
        yield* Effect.void.pipe(Effect.withSpan('test.operation'));
        const flusher = yield* OtlpExporter.Flusher;
        yield* flusher.flush;
      });
      yield* work.pipe(runWithLayer(env, testLayer));
      const tracesReq = Arr.findFirst(received, (r) => r.url === '/v1/traces');
      const metricsReq = Arr.findFirst(received, (r) => r.url === '/v1/metrics');
      assert.isTrue(Option.isSome(tracesReq));
      assert.isTrue(Option.isSome(metricsReq));
      const decoder = new TextDecoder();
      const traceText = decoder.decode(Option.getOrThrow(tracesReq).body);
      const metricText = decoder.decode(Option.getOrThrow(metricsReq).body);
      // Both bodies decode as valid JSON.
      yield* decodeJson(traceText);
      yield* decodeJson(metricText);
      assert.strictEqual(Option.getOrThrow(tracesReq).contentType, 'application/json');
      assert.strictEqual(Option.getOrThrow(tracesReq).authorization, 'Bearer tok');
      assert.include(traceText, '"test.operation"');
      assert.include(traceText, '"llama-test"');
      assert.include(traceText, '"deployment.environment"');
      assert.include(metricText, '"llama_webui_http_requests"');
      assert.include(metricText, '"llama-test"');
    }),
  );

  it.live('exports protobuf by default with application/x-protobuf', () =>
    Effect.gen(function* () {
      const { stub, received } = yield* captureServer;
      const env = { OTEL_EXPORTER_OTLP_ENDPOINT: stub.url };
      const testLayer = Otlp.layerWithClient(NodeHttpClient.layerNodeHttpOptions({ keepAlive: false }));
      yield* Effect.gen(function* () {
        yield* Metric.update(HttpMetrics.defects, 1);
        yield* Effect.void.pipe(Effect.withSpan('proto.span'));
        yield* (yield* OtlpExporter.Flusher).flush;
      }).pipe(runWithLayer(env, testLayer));
      const tracesReq = Option.getOrThrow(Arr.findFirst(received, (r) => r.url === '/v1/traces'));
      const metricsReq = Option.getOrThrow(Arr.findFirst(received, (r) => r.url === '/v1/metrics'));
      assert.strictEqual(tracesReq.contentType, 'application/x-protobuf');
      assert.strictEqual(metricsReq.contentType, 'application/x-protobuf');
      assert.isAbove(tracesReq.body.byteLength, 0);
      assert.isAbove(metricsReq.body.byteLength, 0);
    }),
  );

  it.live('does not send any HTTP request when LLAMA_WEBUI_TEST_OFFLINE=1', () =>
    Effect.gen(function* () {
      const { stub, received } = yield* captureServer;
      const env = {
        OTEL_EXPORTER_OTLP_ENDPOINT: stub.url,
        OTEL_EXPORTER_OTLP_TIMEOUT: '100',
        LLAMA_WEBUI_TEST_OFFLINE: '1',
      };
      yield* Effect.void.pipe(Effect.withSpan('offline.span'), runWithLayer(env, Otlp.layer));
      assert.strictEqual(received.length, 0);
    }),
  );

  it.live('bounds scope finalization to shutdownTimeout when the collector stalls', () =>
    Effect.gen(function* () {
      const stub = yield* httpStub((_req, _res) => {
        // Intentionally never answers: `httpStub`'s finalizer closes open sockets at the end of the test.
      });
      const env = {
        OTEL_EXPORTER_OTLP_ENDPOINT: stub.url,
        OTEL_EXPORTER_OTLP_TIMEOUT: '200',
      };
      const testLayer = Otlp.layerWithClient(NodeHttpClient.layerNodeHttpOptions({ keepAlive: false }));
      const scope = yield* Scope.make();
      const ctx = yield* Layer.buildWithScope(testLayer, scope).pipe(
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
      );
      yield* Effect.void.pipe(Effect.withSpan('slow.span'), Effect.provideContext(ctx));
      const t0 = yield* Clock.currentTimeMillis;
      yield* Scope.close(scope, Exit.void);
      const elapsed = (yield* Clock.currentTimeMillis) - t0;
      assert.isBelow(elapsed, 1000);
    }),
  );

  it.live('accepts an in-memory stub HttpClient without opening sockets', () =>
    Effect.gen(function* () {
      const urls: Array<string> = [];
      const stubClient = HttpClient.make((req) => {
        urls.push(req.url);
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response('{}', { status: 200 })));
      });
      const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.invalid:4318', OTEL_METRICS_EXPORTER: 'none' };
      yield* Effect.gen(function* () {
        yield* Effect.void.pipe(Effect.withSpan('stub.span'));
        yield* (yield* OtlpExporter.Flusher).flush;
      }).pipe(runWithLayer(env, Otlp.layerWithClient(Layer.succeed(HttpClient.HttpClient, stubClient))));
      assert.deepStrictEqual(urls, ['http://collector.invalid:4318/v1/traces']);
    }),
  );

  it.live('chains with a wrapping tracer (such as Effect DevTools in dev)', () =>
    Effect.gen(function* () {
      const mirrored: Array<string> = [];
      const otlpBodies: Array<string> = [];
      const stubClient = HttpClient.make((req) => {
        if (req.body._tag === 'Uint8Array') otlpBodies.push(new TextDecoder().decode(req.body.body));
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response('{}', { status: 200 })));
      });
      const wrapper = Layer.effect(
        Tracer.Tracer,
        Effect.gen(function* () {
          const inner = yield* Effect.tracer;
          return Tracer.make({
            span(options) {
              mirrored.push(options.name);
              return inner.span(options);
            },
            context: inner.context,
          });
        }),
      );
      const env = {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.invalid:4318',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_METRICS_EXPORTER: 'none',
      };
      const combined = wrapper.pipe(
        Layer.provideMerge(Otlp.layerWithClient(Layer.succeed(HttpClient.HttpClient, stubClient))),
      );
      yield* Effect.gen(function* () {
        yield* Effect.void.pipe(Effect.withSpan('chained.span'));
        yield* (yield* OtlpExporter.Flusher).flush;
      }).pipe(runWithLayer(env, combined));
      assert.include(mirrored, 'chained.span');
      assert.include(Arr.join(otlpBodies, '\n'), '"chained.span"');
    }),
  );
});
