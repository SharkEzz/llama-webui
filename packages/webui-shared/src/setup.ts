import { Schema } from 'effect';
import { BenchDevice } from './bench.ts';
import { FitVerdict } from './tuning.ts';

const Listen = Schema.Struct({
  host: Schema.String,
  /** Listening on a non-loopback address. */
  exposed: Schema.Boolean,
});

/** First-run checklist: what llama-webui needs, and what makes it work better. */
export const SetupReport = Schema.Struct({
  binary: Schema.Struct({
    /** The `binary` setting as typed. */
    setting: Schema.String,
    /** Resolved absolute path, null when it cannot be found. */
    path: Schema.NullOr(Schema.String),
    /** “b12119 (6f1e65437)”, null when `--version` cannot be read. */
    version: Schema.NullOr(Schema.String),
  }),
  bench: Schema.Struct({
    /** `llama-bench` derived from the server binary. */
    path: Schema.String,
    /** Empty when llama-bench is missing or fails. */
    devices: Schema.Array(BenchDevice),
  }),
  models: Schema.Struct({
    /** The `modelsDir` setting as typed. */
    setting: Schema.String,
    /** Expanded path. */
    dir: Schema.String,
    exists: Schema.Boolean,
    /** Readable models (projectors excluded). */
    count: Schema.Int,
    bytes: Schema.Finite,
  }),
  /** GPUs and DRAM bandwidth come from the live monitor snapshot (NVML lists its cards after the first tick). */
  telemetry: Schema.Struct({
    nvidiaSource: Schema.Literals(['nvml', 'nvidia-smi']),
    /** `kernel.perf_event_paranoid`, null when unreadable. */
    perfParanoid: Schema.NullOr(Schema.Int),
  }),
  listen: Listen,
  /** The default `--host` of llama-server (Settings), exposed when it is not loopback. */
  llamaListen: Listen,
  /** The required steps pass: the binary is found and the models folder exists. */
  ready: Schema.Boolean,
});
export type SetupReport = typeof SetupReport.Type;

/** One card of the launch pad. */
export const LaunchpadEntry = Schema.Struct({
  profileId: Schema.Int,
  name: Schema.String,
  /** Absolute model path, null when the profile cannot be resolved. */
  modelPath: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.Struct({ name: Schema.String, quant: Schema.String, fileBytes: Schema.Finite })),
  modelError: Schema.NullOr(Schema.String),
  /** Latest successful benchmark run of this profile. */
  lastBench: Schema.NullOr(
    Schema.Struct({ ppTps: Schema.NullOr(Schema.Finite), tgTps: Schema.NullOr(Schema.Finite), at: Schema.Int }),
  ),
  /** Memory estimate with the profile's own args. */
  fit: Schema.NullOr(
    Schema.Struct({
      verdict: FitVerdict,
      reason: Schema.NullOr(Schema.String),
      /** Planned on the GPUs, all cards together. */
      vramBytes: Schema.Finite,
      /** Left in system RAM (CPU layers, offloaded experts). */
      ramBytes: Schema.Finite,
    }),
  ),
});
export type LaunchpadEntry = typeof LaunchpadEntry.Type;

const LOOPBACK = /^(127\.|::1$|localhost$|\[::1\]$)/;

export const isLoopback = (host: string): boolean => LOOPBACK.test(host);
