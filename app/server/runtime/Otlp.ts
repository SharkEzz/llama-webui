import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { Array as Arr, Config, Duration, Effect, Layer, Metric, Option, Schema, String as Str } from 'effect';
import { HttpClient } from 'effect/http';
import { OtlpExporter, OtlpMetrics, OtlpSerialization, OtlpTracer } from 'effect/observability';
import { VERSION } from '../config/AppInfo.ts';
import { isTestOffline, offlineClient, proxyEnv } from '../http/proxyEnv.ts';

/** Default final flush bound on shutdown, kept below the 2 s shutdown budget even when a collector is unreachable. */
const DEFAULT_SHUTDOWN_TIMEOUT = Duration.seconds(1);
const DEFAULT_TRACES_INTERVAL = Duration.seconds(5);
const DEFAULT_METRICS_INTERVAL = Duration.seconds(60);
const DEFAULT_MAX_BATCH_SIZE = 1000;
const DEFAULT_MAX_QUEUE_SIZE = 2048;

export type OtlpProtocol = 'http/protobuf' | 'http/json';
export type OtlpCompression = 'gzip' | 'none';

export interface OtlpResourceConfig {
  readonly serviceName: string;
  readonly serviceVersion: string;
}

interface SignalBase {
  readonly url: string;
  readonly protocol: OtlpProtocol;
  readonly headers: Record<string, string> | undefined;
  readonly compression: OtlpCompression;
  readonly shutdownTimeout: Duration.Duration;
  readonly resource: OtlpResourceConfig;
}

export interface TracesSettings extends SignalBase {
  readonly exportInterval: Duration.Duration;
  readonly maxBatchSize: number;
  readonly maxQueueSize: number;
}

export interface MetricsSettings extends SignalBase {
  readonly exportInterval: Duration.Duration;
  readonly temporality: OtlpMetrics.AggregationTemporality;
}

export interface OtlpPlan {
  readonly traces: Option.Option<TracesSettings>;
  readonly metrics: Option.Option<MetricsSettings>;
}

const ExporterKind = Config.Literals(['otlp', 'none'] as const);
const ProtocolConfig = Config.Literals(['http/protobuf', 'http/json'] as const);
const CompressionConfig = Config.Literals(['gzip', 'none'] as const);
const TemporalityConfig = Config.Literals(['cumulative', 'delta'] as const);

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const headersConfig = (name: string) =>
  Config.option(Config.Record(Schema.String, Schema.StringFromUriComponent, name, { trim: true }));

const appendSignalPath = (base: URL, signal: 'traces' | 'metrics'): string => {
  const slash = Str.endsWith('/')(base.pathname) ? '' : '/';
  base.pathname = `${base.pathname}${slash}v1/${signal}`;
  return base.toString();
};

const signalEndpoint = (signal: 'TRACES' | 'METRICS', suffix: 'traces' | 'metrics') =>
  Config.option(Config.URL(`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`)).pipe(
    Config.flatMap((specific) =>
      Option.isSome(specific)
        ? Config.succeed(Option.some(specific.value.toString()))
        : Config.option(Config.URL('OTEL_EXPORTER_OTLP_ENDPOINT')).pipe(
            Config.map(Option.map((base) => appendSignalPath(base, suffix))),
          ),
    ),
  );

const serializationLayer = (protocol: OtlpProtocol) =>
  protocol === 'http/json' ? OtlpSerialization.layerJson : OtlpSerialization.layerProtobuf;

/**
 * Reads standard OpenTelemetry `OTEL_*` environment variables for OTLP/HTTP export of spans and metrics.
 *
 * Follows OpenTelemetry defaults: setting `OTEL_EXPORTER_OTLP_ENDPOINT` (or a signal-specific endpoint) enables export
 * over `http/protobuf` unless `OTEL_SDK_DISABLED=true` or `OTEL_<SIGNAL>_EXPORTER=none`. With no endpoint configured,
 * both signals stay disabled (`Option.none()`).
 */
export const readOtlpConfig: Effect.Effect<OtlpPlan, Config.ConfigError> = Effect.gen(function* () {
  const disabled = yield* Config.Boolean('OTEL_SDK_DISABLED').pipe(Config.withDefault(false));
  if (disabled) return { traces: Option.none(), metrics: Option.none() };

  const [tracesUrl, metricsUrl, tracesExporter, metricsExporter] = yield* Config.all([
    signalEndpoint('TRACES', 'traces'),
    signalEndpoint('METRICS', 'metrics'),
    Config.option(Config.nested(ExporterKind, 'OTEL_TRACES_EXPORTER')).pipe(
      Config.map(Option.getOrElse(() => 'otlp' as const)),
    ),
    Config.option(Config.nested(ExporterKind, 'OTEL_METRICS_EXPORTER')).pipe(
      Config.map(Option.getOrElse(() => 'otlp' as const)),
    ),
  ]);

  const activeTracesUrl = tracesExporter === 'otlp' ? tracesUrl : Option.none();
  const activeMetricsUrl = metricsExporter === 'otlp' ? metricsUrl : Option.none();
  if (Option.isNone(activeTracesUrl) && Option.isNone(activeMetricsUrl)) {
    return { traces: Option.none(), metrics: Option.none() };
  }

  const [
    baseProtocol,
    tracesProtocol,
    metricsProtocol,
    baseHeaders,
    tracesHeaders,
    metricsHeaders,
    baseCompression,
    tracesCompression,
    metricsCompression,
    baseTimeout,
    tracesTimeout,
    metricsTimeout,
    bspExportTimeout,
    metricExportTimeout,
    bspScheduleDelay,
    bspMaxBatchSize,
    bspMaxQueueSize,
    metricExportInterval,
    temporality,
    envServiceName,
    envServiceVersion,
    resourceAttrs,
  ] = yield* Config.all([
    Config.option(Config.nested(ProtocolConfig, 'OTEL_EXPORTER_OTLP_PROTOCOL')),
    Config.option(Config.nested(ProtocolConfig, 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL')),
    Config.option(Config.nested(ProtocolConfig, 'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL')),
    headersConfig('OTEL_EXPORTER_OTLP_HEADERS'),
    headersConfig('OTEL_EXPORTER_OTLP_TRACES_HEADERS'),
    headersConfig('OTEL_EXPORTER_OTLP_METRICS_HEADERS'),
    Config.option(Config.nested(CompressionConfig, 'OTEL_EXPORTER_OTLP_COMPRESSION')),
    Config.option(Config.nested(CompressionConfig, 'OTEL_EXPORTER_OTLP_TRACES_COMPRESSION')),
    Config.option(Config.nested(CompressionConfig, 'OTEL_EXPORTER_OTLP_METRICS_COMPRESSION')),
    Config.option(Config.schema(PositiveInt, 'OTEL_EXPORTER_OTLP_TIMEOUT')),
    Config.option(Config.schema(PositiveInt, 'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT')),
    Config.option(Config.schema(PositiveInt, 'OTEL_EXPORTER_OTLP_METRICS_TIMEOUT')),
    Config.option(Config.schema(PositiveInt, 'OTEL_BSP_EXPORT_TIMEOUT')),
    Config.option(Config.schema(PositiveInt, 'OTEL_METRIC_EXPORT_TIMEOUT')),
    Config.option(Config.schema(PositiveInt, 'OTEL_BSP_SCHEDULE_DELAY')),
    Config.option(Config.schema(PositiveInt, 'OTEL_BSP_MAX_EXPORT_BATCH_SIZE')),
    Config.option(Config.schema(PositiveInt, 'OTEL_BSP_MAX_QUEUE_SIZE')),
    Config.option(Config.schema(PositiveInt, 'OTEL_METRIC_EXPORT_INTERVAL')),
    Config.option(Config.nested(TemporalityConfig, 'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE')),
    Config.option(Config.String('OTEL_SERVICE_NAME')),
    Config.option(Config.String('OTEL_SERVICE_VERSION')),
    Config.option(
      Config.Record(Schema.StringFromUriComponent, Schema.StringFromUriComponent, 'OTEL_RESOURCE_ATTRIBUTES', {
        trim: true,
        keepEmptyValues: true,
      }),
    ),
  ]);

  const attrs = Option.getOrUndefined(resourceAttrs);
  const attrServiceName = attrs?.['service.name'];
  const attrServiceVersion = attrs?.['service.version'];
  const resource: OtlpResourceConfig = {
    serviceName: Option.getOrElse(envServiceName, () =>
      attrServiceName !== undefined && attrServiceName !== '' ? attrServiceName : 'llama-webui',
    ),
    serviceVersion: Option.getOrElse(envServiceVersion, () =>
      attrServiceVersion !== undefined && attrServiceVersion !== '' ? attrServiceVersion : VERSION,
    ),
  };

  const traces: Option.Option<TracesSettings> = Option.map(activeTracesUrl, (url) => ({
    url,
    protocol: Option.getOrElse(Option.firstSomeOf([tracesProtocol, baseProtocol]), () => 'http/protobuf' as const),
    headers: Option.getOrUndefined(Option.firstSomeOf([tracesHeaders, baseHeaders])),
    compression: Option.getOrElse(Option.firstSomeOf([tracesCompression, baseCompression]), () => 'none' as const),
    shutdownTimeout: Option.match(Option.firstSomeOf([tracesTimeout, baseTimeout, bspExportTimeout]), {
      onNone: () => DEFAULT_SHUTDOWN_TIMEOUT,
      onSome: Duration.millis,
    }),
    exportInterval: Option.match(bspScheduleDelay, { onNone: () => DEFAULT_TRACES_INTERVAL, onSome: Duration.millis }),
    maxBatchSize: Option.getOrElse(bspMaxBatchSize, () => DEFAULT_MAX_BATCH_SIZE),
    maxQueueSize: Option.getOrElse(bspMaxQueueSize, () => DEFAULT_MAX_QUEUE_SIZE),
    resource,
  }));

  const metrics: Option.Option<MetricsSettings> = Option.map(activeMetricsUrl, (url) => ({
    url,
    protocol: Option.getOrElse(Option.firstSomeOf([metricsProtocol, baseProtocol]), () => 'http/protobuf' as const),
    headers: Option.getOrUndefined(Option.firstSomeOf([metricsHeaders, baseHeaders])),
    compression: Option.getOrElse(Option.firstSomeOf([metricsCompression, baseCompression]), () => 'none' as const),
    shutdownTimeout: Option.match(Option.firstSomeOf([metricsTimeout, baseTimeout, metricExportTimeout]), {
      onNone: () => DEFAULT_SHUTDOWN_TIMEOUT,
      onSome: Duration.millis,
    }),
    exportInterval: Option.match(metricExportInterval, {
      onNone: () => DEFAULT_METRICS_INTERVAL,
      onSome: Duration.millis,
    }),
    temporality: Option.getOrElse(temporality, () => 'cumulative' as const),
    resource,
  }));

  return { traces, metrics };
});

const buildLayers = (plan: OtlpPlan): Layer.Layer<OtlpExporter.Flusher, never, HttpClient.HttpClient> => {
  const tracesLayer = Option.match(plan.traces, {
    onNone: () => OtlpExporter.layerFlusher,
    onSome: (t) =>
      OtlpTracer.layer({
        url: t.url,
        resource: t.resource,
        headers: t.headers,
        compression: t.compression,
        exportInterval: t.exportInterval,
        maxBatchSize: t.maxBatchSize,
        maxQueueSize: t.maxQueueSize,
        shutdownTimeout: t.shutdownTimeout,
      }).pipe(Layer.provide(serializationLayer(t.protocol))),
  });

  const metricsLayer = Option.match(plan.metrics, {
    onNone: () => OtlpExporter.layerFlusher,
    onSome: (m) =>
      Layer.merge(
        OtlpMetrics.layer({
          url: m.url,
          resource: m.resource,
          headers: m.headers,
          compression: m.compression,
          exportInterval: m.exportInterval,
          shutdownTimeout: m.shutdownTimeout,
          temporality: m.temporality,
        }).pipe(Layer.provide(serializationLayer(m.protocol))),
        Metric.enableRuntimeMetricsLayer,
      ),
  });

  return Layer.merge(tracesLayer, metricsLayer);
};

const summaryOf = (plan: OtlpPlan): string => {
  const parts: Array<string> = [];
  if (Option.isSome(plan.traces)) parts.push(`traces → ${plan.traces.value.url} (${plan.traces.value.protocol})`);
  if (Option.isSome(plan.metrics)) parts.push(`metrics → ${plan.metrics.value.url} (${plan.metrics.value.protocol})`);
  return Arr.join(parts, ', ');
};

/** OTLP traces and metrics export using an explicit `HttpClient` layer (used by tests). */
export const layerWithClient = (
  client: Layer.Layer<HttpClient.HttpClient>,
): Layer.Layer<OtlpExporter.Flusher, Config.ConfigError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const plan = yield* readOtlpConfig;
      if (Option.isNone(plan.traces) && Option.isNone(plan.metrics)) return OtlpExporter.layerFlusher;
      yield* Effect.logInfo(`OpenTelemetry OTLP export enabled (${summaryOf(plan)})`);
      return buildLayers(plan).pipe(Layer.provide(client));
    }),
  );

/**
 * OTLP/HTTP export of the server's spans and metrics, driven by standard `OTEL_*` environment variables.
 * Uses its own `NodeHttpClient` with proxy support (loopback direct), or `offlineClient` under
 * `LLAMA_WEBUI_TEST_OFFLINE=1`. Returns `Layer.empty` when no endpoint is configured.
 */
export const layer: Layer.Layer<never, Config.ConfigError> = Layer.unwrap(
  Effect.gen(function* () {
    const plan = yield* readOtlpConfig;
    if (Option.isNone(plan.traces) && Option.isNone(plan.metrics)) return Layer.empty;
    yield* Effect.logInfo(`OpenTelemetry OTLP export enabled (${summaryOf(plan)})`);
    const client = (yield* isTestOffline)
      ? Layer.succeed(HttpClient.HttpClient, offlineClient)
      : NodeHttpClient.layerNodeHttpOptions({ keepAlive: true, proxyEnv: yield* proxyEnv });
    return buildLayers(plan).pipe(Layer.provide(client));
  }),
);
