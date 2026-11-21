import type { DiskSpeed, Estimate } from '@llama-webui/shared';
import { benchBinary } from 'llamacpp-js/node';
import type { AppDeps } from '../deps';
import { readTuningHardware } from './hardware';

/**
 * Latest disk measurements and estimates, per model (in memory: lost on restart, which is harmless). In `lib/`, not in
 * a route file: `/api/tuning/estimate` writes what `/api/tuning/checks` reads, and a route reload would reset them.
 */
export const diskSpeeds = new Map<string, DiskSpeed>();
export const lastEstimates = new Map<string, Estimate>();

/** The hardware the estimator works on: llama-bench's devices, memory and GPUs from the monitor. */
export const tuningHardware = ({ settings, monitor }: Pick<AppDeps, 'settings' | 'monitor'>) =>
  readTuningHardware({
    benchBinary: benchBinary(settings.get().binary),
    mem: monitor.latest()?.system?.mem ?? null,
    gpus: monitor.latest()?.allGpus,
  });
