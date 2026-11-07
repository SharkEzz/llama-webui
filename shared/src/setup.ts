import type { BenchDevice } from './bench';
import type { FitVerdict } from './tuning';

/** First-run checklist: what llama-webui needs, and what makes it work better. */
export interface SetupReport {
  binary: {
    /** The `binary` setting as typed. */
    setting: string;
    /** Resolved absolute path, null when it cannot be found. */
    path: string | null;
    /** “b12119 (6f1e65437)”, null when `--version` cannot be read. */
    version: string | null;
  };
  bench: {
    /** `llama-bench` derived from the server binary. */
    path: string;
    /** Empty when llama-bench is missing or fails. */
    devices: BenchDevice[];
  };
  models: {
    /** The `modelsDir` setting as typed. */
    setting: string;
    /** Expanded path. */
    dir: string;
    exists: boolean;
    /** Readable models (projectors excluded). */
    count: number;
    bytes: number;
  };
  /** GPUs and DRAM bandwidth come from the live monitor snapshot (NVML lists its cards after the first tick). */
  telemetry: {
    nvidiaSource: 'nvml' | 'nvidia-smi';
    /** `kernel.perf_event_paranoid`, null when unreadable. */
    perfParanoid: number | null;
  };
  listen: {
    host: string;
    /** Listening on a non-loopback address. */
    exposed: boolean;
  };
  /** The required steps pass: the binary is found and the models folder exists. */
  ready: boolean;
}

/** One card of the launch pad. */
export interface LaunchpadEntry {
  profileId: number;
  name: string;
  /** Absolute model path, null when the profile cannot be resolved. */
  modelPath: string | null;
  model: { name: string; quant: string; fileBytes: number } | null;
  modelError: string | null;
  /** Latest successful benchmark run of this profile. */
  lastBench: { ppTps: number | null; tgTps: number | null; at: number } | null;
  /** Memory estimate with the profile's own args. */
  fit: {
    verdict: FitVerdict;
    reason: string | null;
    /** Planned on the GPUs, all cards together. */
    vramBytes: number;
    /** Left in system RAM (CPU layers, offloaded experts). */
    ramBytes: number;
  } | null;
}

const LOOPBACK = /^(127\.|::1$|localhost$|\[::1\]$)/;

export const isLoopback = (host: string) => LOOPBACK.test(host);
