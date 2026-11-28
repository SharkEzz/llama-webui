import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { Array as Arr, Config, Duration, Effect, Layer, Metric, Option, Schema, String as Str } from 'effect';
import { HttpClient, HttpClientError } from 'effect/http';
import { OtlpExporter, OtlpMetrics, OtlpSerialization, OtlpTracer } from 'effect/observability';
import { VERSION } from '../config/AppInfo.ts';
import { isTestOffline, offlineClient, proxyEnv } from '../http/proxyEnv.ts';

/** Bound of the final flush on shutdown, below the 2 s shutdown budget even when a collector is unreachable. */
const SHUTDOWN_TIMEOUT = Duration.seconds(1);
/** The OpenTelemetry defaults: `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_BSP_*` and `OTEL_METRIC_EXPORT_INTERVAL`. */
const DEFAULT_EXPORT_TIMEOUT = Duration.seconds(10);
const DEFAULT_TRACES_INTERVAL = Duration.seconds(5);
const DEFAULT_METRICS_INTERVAL = Duration.seconds(60);
const DEFAULT_MAX_BATCH_SIZE = 512;
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
  /** The bound of each export request (a collector that never answers fails it). */
  readonly exportTimeout: Duration.Duration;
  /** The bound of the final flush on shutdown: the export timeout, at most 1 s. */
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

const PROTOCOLS: ReadonlyArray<OtlpProtocol> = ['http/protobuf', 'http/json'];
const CompressionConfig = Config.Literals(['gzip', 'none'] as const);
const TemporalityConfig = Config.Literals(['cumulative', 'delta'] as const);

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

type Signal = 'traces' | 'metrics';
const SIGNAL_KEY = { traces: 'TRACES', metrics: 'METRICS' } as const;

/**
 * A setting that cannot be read is warned about and ignored (its default applies), as the OpenTelemetry spec asks
 * of an SDK: telemetry never stops the server from starting.
 */
const lenient = <A>(name: string, config: Config.Config<Option.Option<A>>): Effect.Effect<Option.Option<A>> =>
  config.pipe(
    Effect.catch((error) =>
      Effect.as(Effect.logWarning(`OpenTelemetry: ignoring ${name}: ${error.message}`), Option.none()),
    ),
  );

/** A variable as written, trimmed; an empty one counts as unset. */
const raw = (name: string): Effect.Effect<Option.Option<string>> =>
  lenient(name, Config.option(Config.String(name)).pipe(Config.map(Option.map(Str.trim)))).pipe(
    Effect.map(Option.filter(Str.isNonEmpty)),
  );

const positiveInt = (name: string) => lenient(name, Config.option(Config.schema(PositiveInt, name)));
const millis = (name: string) => Effect.map(positiveInt(name), Option.map(Duration.millis));

const headers = (name: string) =>
  lenient(name, Config.option(Config.Record(Schema.String, Schema.StringFromUriComponent, name, { trim: true })));

/** `OTEL_SDK_DISABLED`: only `true` (any case) turns export off; any other value but `false` is warned about. */
const sdkDisabled = Effect.gen(function* () {
  const value = yield* raw('OTEL_SDK_DISABLED');
  if (Option.isNone(value)) return false;
  const lower = Str.toLowerCase(value.value);
  if (lower !== 'true' && lower !== 'false') {
    yield* Effect.logWarning(`OpenTelemetry: ignoring OTEL_SDK_DISABLED=${value.value}: expected true or false`);
  }
  return lower === 'true';
});

const appendSignalPath = (base: URL, signal: Signal): string => {
  const slash = Str.endsWith('/')(base.pathname) ? '' : '/';
  base.pathname = `${base.pathname}${slash}v1/${signal}`;
  return base.toString();
};

/** A URL variable; unset or empty is `none`, an invalid URL is warned about and `none`. */
const urlVariable = (name: string) =>
  Effect.flatMap(raw(name), (value) =>
    Option.isNone(value) ? Effect.succeedNone : lenient(name, Config.option(Config.URL(name))),
  );

/** The signal's own endpoint as written, else the base endpoint with `v1/<signal>` appended. */
const signalEndpoint = Effect.fnUntraced(function* (signal: Signal, base: Option.Option<URL>) {
  const specific = yield* urlVariable(`OTEL_EXPORTER_OTLP_${SIGNAL_KEY[signal]}_ENDPOINT`);
  if (Option.isSome(specific)) return Option.some(specific.value.toString());
  return Option.map(base, (endpoint) => appendSignalPath(new URL(endpoint), signal));
});

/**
 * `OTEL_<SIGNAL>_EXPORTER`, a comma-separated list (unset: `otlp`): the signal is exported when `otlp` is in it. The
 * other exporters (`console`, `zipkin`…) do not exist here and are warned about.
 */
const exporterOn = Effect.fnUntraced(function* (signal: Signal) {
  const name = `OTEL_${SIGNAL_KEY[signal]}_EXPORTER`;
  const value = yield* raw(name);
  if (Option.isNone(value)) return true;
  const kinds = Arr.filter(Arr.map(Str.split(value.value, ','), Str.trim), Str.isNonEmpty);
  const unknown = Arr.filter(kinds, (kind) => kind !== 'otlp' && kind !== 'none');
  if (Arr.isReadonlyArrayNonEmpty(unknown)) {
    yield* Effect.logWarning(`OpenTelemetry: ignoring ${Arr.join(unknown, ', ')} in ${name}: only otlp is supported`);
  }
  return Arr.contains(kinds, 'otlp');
});

/**
 * The signal's protocol (its own variable, else the base one, else `http/protobuf`). An unsupported one (`grpc`)
 * turns the signal off with a warning: sending OTLP/HTTP to a gRPC collector would only fail.
 */
const protocolOf = Effect.fnUntraced(function* (signal: Signal, base: Option.Option<string>) {
  const specificName = `OTEL_EXPORTER_OTLP_${SIGNAL_KEY[signal]}_PROTOCOL`;
  const specific = yield* raw(specificName);
  const name = Option.isSome(specific) ? specificName : 'OTEL_EXPORTER_OTLP_PROTOCOL';
  const value = Option.orElse(specific, () => base);
  if (Option.isNone(value)) return Option.some<OtlpProtocol>('http/protobuf');
  const protocol = Arr.findFirst(PROTOCOLS, (known) => known === value.value);
  if (Option.isNone(protocol)) {
    yield* Effect.logWarning(
      `OpenTelemetry: ${name}=${value.value} is not supported (http/protobuf or http/json): ${signal} export is off`,
    );
  }
  return protocol;
});

/** The URL and protocol of a signal that is exported: it has an endpoint, `otlp` among its exporters, a protocol. */
const target = Effect.fnUntraced(function* (
  signal: Signal,
  endpoint: Option.Option<string>,
  baseProtocol: Option.Option<string>,
) {
  if (Option.isNone(endpoint)) return Option.none();
  const on = yield* exporterOn(signal);
  if (!on) return Option.none();
  const protocol = yield* protocolOf(signal, baseProtocol);
  return Option.map(protocol, (wire) => ({ url: endpoint.value, protocol: wire }));
});

/**
 * Reads the standard OpenTelemetry `OTEL_*` environment variables for the OTLP/HTTP export of spans and metrics.
 *
 * A signal is exported when an endpoint names it (`OTEL_EXPORTER_OTLP_ENDPOINT` or its own), unless
 * `OTEL_SDK_DISABLED=true`, `OTEL_<SIGNAL>_EXPORTER` leaves `otlp` out, or its protocol is not supported. With no
 * endpoint, nothing else is read. A value that cannot be read never fails: it is warned about and its default applies.
 */
export const readOtlpConfig: Effect.Effect<OtlpPlan> = Effect.gen(function* () {
  const off: OtlpPlan = { traces: Option.none(), metrics: Option.none() };
  if (yield* sdkDisabled) return off;

  const baseEndpoint = yield* urlVariable('OTEL_EXPORTER_OTLP_ENDPOINT');
  const [tracesEndpoint, metricsEndpoint] = yield* Effect.all([
    signalEndpoint('traces', baseEndpoint),
    signalEndpoint('metrics', baseEndpoint),
  ]);
  if (Option.isNone(tracesEndpoint) && Option.isNone(metricsEndpoint)) return off;

  const baseProtocol = yield* raw('OTEL_EXPORTER_OTLP_PROTOCOL');
  const [tracesTarget, metricsTarget] = yield* Effect.all([
    target('traces', tracesEndpoint, baseProtocol),
    target('metrics', metricsEndpoint, baseProtocol),
  ]);
  if (Option.isNone(tracesTarget) && Option.isNone(metricsTarget)) return off;

  const [
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
  ] = yield* Effect.all([
    headers('OTEL_EXPORTER_OTLP_HEADERS'),
    headers('OTEL_EXPORTER_OTLP_TRACES_HEADERS'),
    headers('OTEL_EXPORTER_OTLP_METRICS_HEADERS'),
    lenient(
      'OTEL_EXPORTER_OTLP_COMPRESSION',
      Config.option(Config.nested(CompressionConfig, 'OTEL_EXPORTER_OTLP_COMPRESSION')),
    ),
    lenient(
      'OTEL_EXPORTER_OTLP_TRACES_COMPRESSION',
      Config.option(Config.nested(CompressionConfig, 'OTEL_EXPORTER_OTLP_TRACES_COMPRESSION')),
    ),
    lenient(
      'OTEL_EXPORTER_OTLP_METRICS_COMPRESSION',
      Config.option(Config.nested(CompressionConfig, 'OTEL_EXPORTER_OTLP_METRICS_COMPRESSION')),
    ),
    millis('OTEL_EXPORTER_OTLP_TIMEOUT'),
    millis('OTEL_EXPORTER_OTLP_TRACES_TIMEOUT'),
    millis('OTEL_EXPORTER_OTLP_METRICS_TIMEOUT'),
    millis('OTEL_BSP_EXPORT_TIMEOUT'),
    millis('OTEL_METRIC_EXPORT_TIMEOUT'),
    millis('OTEL_BSP_SCHEDULE_DELAY'),
    positiveInt('OTEL_BSP_MAX_EXPORT_BATCH_SIZE'),
    positiveInt('OTEL_BSP_MAX_QUEUE_SIZE'),
    millis('OTEL_METRIC_EXPORT_INTERVAL'),
    lenient(
      'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE',
      Config.option(Config.nested(TemporalityConfig, 'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE')),
    ),
    raw('OTEL_SERVICE_NAME'),
    raw('OTEL_SERVICE_VERSION'),
    lenient(
      'OTEL_RESOURCE_ATTRIBUTES',
      Config.option(
        Config.Record(Schema.StringFromUriComponent, Schema.StringFromUriComponent, 'OTEL_RESOURCE_ATTRIBUTES', {
          trim: true,
          keepEmptyValues: true,
        }),
      ),
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

  /** The request bound, from the most specific variable that is set; the shutdown flush takes it, at most 1 s. */
  const timeouts = (candidates: ReadonlyArray<Option.Option<Duration.Duration>>) => {
    const exportTimeout = Option.getOrElse(Option.firstSomeOf(candidates), () => DEFAULT_EXPORT_TIMEOUT);
    return { exportTimeout, shutdownTimeout: Duration.min(exportTimeout, SHUTDOWN_TIMEOUT) };
  };

  const traces: Option.Option<TracesSettings> = Option.map(tracesTarget, ({ url, protocol }) => ({
    url,
    protocol,
    headers: Option.getOrUndefined(Option.firstSomeOf([tracesHeaders, baseHeaders])),
    compression: Option.getOrElse(Option.firstSomeOf([tracesCompression, baseCompression]), () => 'none' as const),
    ...timeouts([tracesTimeout, baseTimeout, bspExportTimeout]),
    exportInterval: Option.getOrElse(bspScheduleDelay, () => DEFAULT_TRACES_INTERVAL),
    maxBatchSize: Option.getOrElse(bspMaxBatchSize, () => DEFAULT_MAX_BATCH_SIZE),
    maxQueueSize: Option.getOrElse(bspMaxQueueSize, () => DEFAULT_MAX_QUEUE_SIZE),
    resource,
  }));

  const metrics: Option.Option<MetricsSettings> = Option.map(metricsTarget, ({ url, protocol }) => ({
    url,
    protocol,
    headers: Option.getOrUndefined(Option.firstSomeOf([metricsHeaders, baseHeaders])),
    compression: Option.getOrElse(Option.firstSomeOf([metricsCompression, baseCompression]), () => 'none' as const),
    ...timeouts([metricsTimeout, baseTimeout, metricExportTimeout]),
    exportInterval: Option.getOrElse(metricExportInterval, () => DEFAULT_METRICS_INTERVAL),
    temporality: Option.getOrElse(temporality, () => 'cumulative' as const),
    resource,
  }));

  return { traces, metrics };
});

const serializationLayer = (protocol: OtlpProtocol) =>
  protocol === 'http/json' ? OtlpSerialization.layerJson : OtlpSerialization.layerProtobuf;

/**
 * The client with each request bounded: a collector that accepts the connection and never answers fails the export
 * (a transport error, retried then disabled for a while by the exporter) instead of holding one of its slots forever.
 */
const boundedClient = (timeout: Duration.Duration): Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.transform((response, request) =>
        Effect.timeoutOrElse(response, {
          duration: timeout,
          orElse: () =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: `no answer in ${Duration.format(timeout)}`,
                }),
              }),
            ),
        }),
      ),
    ),
  );

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
      }).pipe(Layer.provide(serializationLayer(t.protocol)), Layer.provide(boundedClient(t.exportTimeout))),
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
        }).pipe(Layer.provide(serializationLayer(m.protocol)), Layer.provide(boundedClient(m.exportTimeout))),
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
export const layerWithClient = (client: Layer.Layer<HttpClient.HttpClient>): Layer.Layer<OtlpExporter.Flusher> =>
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
